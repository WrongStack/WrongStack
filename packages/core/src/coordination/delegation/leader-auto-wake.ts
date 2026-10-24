/**
 * LeaderAutoWakeController — starts a new leader turn when a background
 * delegation result arrives while the leader is idle.
 *
 * A running leader loop drains `LeaderDeliveryHub` itself at iteration
 * boundaries; this controller only covers the idle case. It never delivers
 * content: the woken turn's prompt names the delegation ids, and the results
 * enter the conversation through the normal loop drain on iteration 0.
 *
 * Host contract — every surface that can run a leader turn supplies a
 * {@link LeaderWakePort} and calls:
 *   - `onRunFinished(sessionId)` once a run ended and nothing queued follows
 *     (post-run check: a result that landed during the final iteration);
 *   - `onSessionDisplayed(sessionId)` when a surface starts showing a session
 *     (results for an undisplayed session are HELD, never woken headless);
 *   - `noteUserInput(sessionId)` whenever the user submits input (resets the
 *     chain cap).
 *
 * Guards, in order: enabled → wake-eligible pending items → open → displayed
 * (else hold) → idle, no queued user input, no pending confirm (else wait for
 * the post-run check) → rate limit (else retry when the interval elapses) →
 * chain cap (else hold + `leader.auto_wake_suppressed`).
 *
 * Eligibility is the hub item's own `wake` flag, so a user-caused or
 * boot-rehydrated item never causes a wake, not even later through the
 * post-run check. The woken turn runs under whatever autonomy/permission mode
 * is live; this controller never changes it.
 *
 * Every timer is unref'd: a pending wake never keeps the process alive.
 *
 * @module coordination/delegation/leader-auto-wake
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import {
  type LeaderDeliveryHub,
  type LeaderDeliveryPendingEvent,
  leaderDeliveryHub,
} from './leader-delivery-hub.js';

/** What a host surface must answer for the controller to wake a session. */
export interface LeaderWakePort {
  /** No leader run in flight for the session (and nothing else driving the agent). */
  isIdle(sessionId: string): boolean;
  /** User input is queued or being submitted for the session. */
  hasPendingUserInput(sessionId: string): boolean;
  /** A tool confirmation / structured input form is waiting on the user. */
  isConfirmPending(sessionId: string): boolean;
  /** The host knows (hosts) this session. */
  isOpen(sessionId: string): boolean;
  /** At least one surface currently shows this session (Q1: else hold). */
  isDisplayed(sessionId: string): boolean;
  /**
   * Start a leader turn with `prompt` as its input. May resolve when the turn
   * has started or when it finished; a rejection is logged, never thrown.
   */
  startWakeTurn(sessionId: string, prompt: string): Promise<void>;
}

export interface LeaderAutoWakeConfig {
  /** Default true. False disables auto-wake entirely. */
  autoWake?: boolean | undefined;
  /** Coalescing window. Default 1500. */
  autoWakeDebounceMs?: number | undefined;
  /** Consecutive woken turns without user input. Default 5. */
  maxChainedWakes?: number | undefined;
}

export type LeaderAutoWakeSuppressedReason = 'chain_cap' | 'undisplayed';

export interface LeaderAutoWakeStartedEvent {
  sessionId: string;
  deliveryIds: string[];
  delegationIds: string[];
  /** 1-based position in the current chain of woken turns. */
  chain: number;
}

export interface LeaderAutoWakeSuppressedEvent {
  sessionId: string;
  reason: LeaderAutoWakeSuppressedReason;
  /** Wake-eligible items left pending. */
  pending: number;
}

/** Outcome of one guard evaluation — returned for tests and diagnostics. */
export type LeaderWakeDecision =
  | 'woken'
  | 'disabled'
  | 'nothing_pending'
  | 'no_port'
  | 'closed'
  | 'undisplayed'
  | 'busy'
  | 'rate_limited'
  | 'chain_cap';

export interface LeaderAutoWakeControllerOptions {
  /** Live config reader (user config only — `fleet` is denied in project config). */
  config?: (() => LeaderAutoWakeConfig | undefined) | undefined;
  events?: EventBus | undefined;
  hub?: LeaderDeliveryHub | undefined;
  /** Minimum interval between wakes per session. Default 30000. */
  minWakeIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
  logger?: { warn?: ((msg: string) => void) | undefined } | undefined;
}

export const AUTO_WAKE_MARKER = '[AUTO-WAKE]';
export const DEFAULT_AUTO_WAKE_DEBOUNCE_MS = 1_500;
export const DEFAULT_MAX_CHAINED_WAKES = 5;
export const DEFAULT_MIN_WAKE_INTERVAL_MS = 30_000;

/**
 * The woken turn's input. Carries the delegation ids so two wakes are never
 * byte-identical (Agent.run burst-dedupes identical input) and so the model
 * can match the `[DELEGATION RESULT]` blocks that follow. No result content.
 */
export function buildAutoWakePrompt(delegationIds: readonly string[]): string {
  return `${AUTO_WAKE_MARKER} Background delegation result(s) arrived: ${delegationIds.join(', ')}. Review and continue.`;
}

interface SessionWakeState {
  timer: ReturnType<typeof setTimeout> | null;
  lastWakeAt: number;
  chain: number;
  /** A `startWakeTurn` call has not resolved and no run finished since. */
  inFlight: boolean;
  wakeGeneration: number;
  capNotified: boolean;
  holdNotified: boolean;
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/\\/g, '/');
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

export class LeaderAutoWakeController {
  private port: LeaderWakePort | null = null;
  private readonly sessions = new Map<string, SessionWakeState>();
  private readonly hub: LeaderDeliveryHub;
  private readonly offHub: () => void;
  private disposed = false;

  constructor(private readonly opts: LeaderAutoWakeControllerOptions = {}) {
    this.hub = opts.hub ?? leaderDeliveryHub;
    this.offHub = this.hub.on((event) => this.onDeliveryPending(event));
  }

  /** Bind the host surface. Returns a detach function. */
  attachPort(port: LeaderWakePort): () => void {
    this.port = port;
    return () => {
      if (this.port === port) this.port = null;
    };
  }

  /** Post-run check: re-run the guards when wake-eligible results wait. */
  onRunFinished(sessionId: string): LeaderWakeDecision {
    const state = this.state(sessionId);
    state.inFlight = false;
    if (this.eligible(sessionId).length === 0) return 'nothing_pending';
    return this.evaluate(sessionId);
  }

  /** A surface started showing the session: release a Q1 hold. */
  onSessionDisplayed(sessionId: string): LeaderWakeDecision {
    if (this.eligible(sessionId).length === 0) return 'nothing_pending';
    return this.evaluate(sessionId);
  }

  /** The user submitted input: the next woken turn starts a fresh chain. */
  noteUserInput(sessionId: string): void {
    const state = this.state(sessionId);
    state.chain = 0;
    state.capNotified = false;
  }

  /** Consecutive woken turns since the last user input (diagnostics). */
  chainLength(sessionId: string): number {
    return this.sessions.get(normalizeSessionId(sessionId))?.chain ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offHub();
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
    this.sessions.clear();
    this.port = null;
  }

  /**
   * Run every guard now and wake when they pass. Public for hosts that need
   * an explicit re-check; the hub listener and the host hooks call it.
   */
  evaluate(rawSessionId: string): LeaderWakeDecision {
    if (this.disposed) return 'disabled';
    const sessionId = normalizeSessionId(rawSessionId);
    const config = this.readConfig();
    if (config.autoWake === false) return 'disabled';
    const items = this.eligible(sessionId);
    if (items.length === 0) return 'nothing_pending';
    const port = this.port;
    if (!port) return 'no_port';
    const state = this.state(sessionId);
    try {
      if (!port.isOpen(sessionId)) return 'closed';
      if (!port.isDisplayed(sessionId)) {
        if (!state.holdNotified) {
          state.holdNotified = true;
          this.emitSuppressed(sessionId, 'undisplayed', items.length);
        }
        return 'undisplayed';
      }
      state.holdNotified = false;
      if (
        state.inFlight ||
        !port.isIdle(sessionId) ||
        port.hasPendingUserInput(sessionId) ||
        port.isConfirmPending(sessionId)
      ) {
        return 'busy';
      }
    } catch (err) {
      this.warn(`auto-wake guard failed for ${sessionId}: ${String(err)}`);
      return 'busy';
    }
    const now = this.now();
    const interval = Math.max(0, this.opts.minWakeIntervalMs ?? DEFAULT_MIN_WAKE_INTERVAL_MS);
    const elapsed = now - state.lastWakeAt;
    if (state.lastWakeAt > 0 && elapsed >= 0 && elapsed < interval) {
      this.schedule(sessionId, interval - elapsed);
      return 'rate_limited';
    }
    const maxChain = Math.max(0, config.maxChainedWakes ?? DEFAULT_MAX_CHAINED_WAKES);
    if (state.chain >= maxChain) {
      if (!state.capNotified) {
        state.capNotified = true;
        this.emitSuppressed(sessionId, 'chain_cap', items.length);
      }
      return 'chain_cap';
    }

    state.chain += 1;
    state.lastWakeAt = now;
    state.inFlight = true;
    const generation = ++state.wakeGeneration;
    const deliveryIds = items.map((item) => item.deliveryId);
    const delegationIds = items.map((item) => item.payload.delegationId);
    try {
      this.opts.events?.emit('leader.auto_wake_started', {
        sessionId,
        deliveryIds,
        delegationIds,
        chain: state.chain,
      } satisfies LeaderAutoWakeStartedEvent);
    } catch {
      // Observability must never block the wake.
    }
    let started: Promise<void>;
    try {
      started = Promise.resolve(port.startWakeTurn(sessionId, buildAutoWakePrompt(delegationIds)));
    } catch (err) {
      started = Promise.reject(err);
    }
    started.then(
      () => {
        if (state.wakeGeneration === generation) state.inFlight = false;
      },
      (err: unknown) => {
        if (state.wakeGeneration === generation) state.inFlight = false;
        this.warn(`auto-wake turn failed for ${sessionId}: ${String(err)}`);
      },
    );
    return 'woken';
  }

  private onDeliveryPending(event: LeaderDeliveryPendingEvent): void {
    if (this.disposed || !event.wake) return;
    if (this.readConfig().autoWake === false) return;
    const debounce = Math.max(
      0,
      this.readConfig().autoWakeDebounceMs ?? DEFAULT_AUTO_WAKE_DEBOUNCE_MS,
    );
    this.schedule(normalizeSessionId(event.sessionId), debounce);
  }

  /**
   * Coalesce: the first trigger arms the timer; later triggers inside the
   * window ride the same evaluation. A shorter pending delay is not extended.
   */
  private schedule(sessionId: string, delayMs: number): void {
    const state = this.state(sessionId);
    if (state.timer) return;
    const timer = setTimeout(() => {
      state.timer = null;
      this.evaluate(sessionId);
    }, delayMs);
    unrefTimer(timer);
    state.timer = timer;
  }

  private eligible(sessionId: string) {
    return this.hub.peek(sessionId).filter((item) => item.wake);
  }

  private state(rawSessionId: string): SessionWakeState {
    const sessionId = normalizeSessionId(rawSessionId);
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        timer: null,
        lastWakeAt: 0,
        chain: 0,
        inFlight: false,
        wakeGeneration: 0,
        capNotified: false,
        holdNotified: false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private readConfig(): LeaderAutoWakeConfig {
    try {
      return this.opts.config?.() ?? {};
    } catch {
      return {};
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private emitSuppressed(
    sessionId: string,
    reason: LeaderAutoWakeSuppressedReason,
    pending: number,
  ): void {
    try {
      this.opts.events?.emit('leader.auto_wake_suppressed', {
        sessionId,
        reason,
        pending,
      } satisfies LeaderAutoWakeSuppressedEvent);
    } catch {
      // Observability must never break the controller.
    }
  }

  private warn(message: string): void {
    try {
      this.opts.logger?.warn?.(message);
    } catch {
      /* ignore */
    }
  }
}
