/**
 * The CLI-hosted WebUI's side of background-delegation auto-wake.
 *
 * Core's `LeaderAutoWakeController` decides WHEN a leader may be woken; this
 * module answers its host questions for a multi-tab WebUI process and starts
 * the woken turn through the SAME conversation path a user message takes
 * (`createConversationOperations().startRuntimeTurn`), so the run lock, the
 * session transition gate, journaling, broadcasts and lane routing all apply.
 *
 * It never constructs a controller. The process owns exactly one — created by
 * the CLI host that owns the delegate tool and the delivery hub — and passes it
 * in: two controllers on one hub would wake every session twice.
 *
 * Port answers, per session:
 *   - isIdle              no run lock held (`abortControllers`)
 *   - hasPendingUserInput a user message is between submit and lock claim
 *   - isConfirmPending    a tool confirm or a structured input form waits
 *   - isOpen / isDisplayed supplied by the host (registry, connected tabs)
 *
 * Host hooks it expects to be called:
 *   - `onUserMessage`     every real user submit (resets the chain cap)
 *   - `onRunEnded`        a run released its lock; user-aborted runs never wake
 *   - `onSessionsDisplayed` a tab started showing sessions (releases a Q1 hold)
 *
 * It also forwards the controller's and hub's events to the tabs showing the
 * session: `delegation.delivery_pending`, `delegation.auto_wake_started`,
 * `delegation.auto_wake_suppressed` (chain cap only — an undisplayed session
 * has, by definition, no tab to tell).
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import {
  type LeaderDeliveryHub,
  type LeaderWakePort,
  leaderDeliveryHub,
} from '@wrongstack/core/coordination';
import type { PendingConfirm } from './pending-confirms.js';

/** The controller surface this host drives (core's `LeaderAutoWakeController`). */
export interface WebuiLeaderAutoWakeController {
  attachPort(port: LeaderWakePort): () => void;
  onRunFinished(sessionId: string): unknown;
  onSessionDisplayed(sessionId: string): unknown;
  noteUserInput(sessionId: string): void;
}

export type RuntimeTurnStarter = (sessionId: string, prompt: string) => Promise<boolean>;

export interface WebuiLeaderAutoWakeHostOptions {
  controller: WebuiLeaderAutoWakeController;
  events: EventBus;
  /** Session-keyed run locks — the same map the conversation run control uses. */
  abortControllers: ReadonlyMap<string, AbortController>;
  pendingConfirms: ReadonlyMap<string, PendingConfirm>;
  /** The host serves this session (it has a live writer for it). */
  isOpen(sessionId: string): boolean;
  /** At least one connected tab currently displays this session. */
  isDisplayed(sessionId: string): boolean;
  /** Session-filtered broadcast (delivered only to tabs showing the payload's session). */
  broadcast(message: { type: string; payload: unknown }): void;
  hub?: Pick<LeaderDeliveryHub, 'peek'> | undefined;
  logger?: { warn?: ((message: string) => void) | undefined } | undefined;
}

export interface WebuiLeaderAutoWakeHost {
  onUserMessage(sessionId: string): () => void;
  onRunEnded(sessionId: string, info: { aborted: boolean }): void;
  /** Bind the conversation path's runtime-turn starter. Returns an unbind. */
  bindRuntimeTurnStarter(start: RuntimeTurnStarter): () => void;
  onSessionsDisplayed(sessionIds: readonly string[]): void;
  /** The port bound to the controller (exposed for tests and diagnostics). */
  readonly port: LeaderWakePort;
  dispose(): void;
}

function safely(logger: WebuiLeaderAutoWakeHostOptions['logger'], label: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    try {
      logger?.warn?.(`webui auto-wake ${label} failed: ${String(err)}`);
    } catch {
      /* ignore */
    }
  }
}

export function createWebuiLeaderAutoWakeHost(
  opts: WebuiLeaderAutoWakeHostOptions,
): WebuiLeaderAutoWakeHost {
  const hub = opts.hub ?? leaderDeliveryHub;
  /** Submits between arrival and run-lock claim, per session. */
  const pendingSubmits = new Map<string, number>();
  /** Open structured input forms (user.input_requested not yet resolved), per session. */
  const openForms = new Map<string, Set<string>>();
  let starter: RuntimeTurnStarter | null = null;
  let disposed = false;

  const confirmPending = (sessionId: string): boolean => {
    for (const confirm of opts.pendingConfirms.values()) {
      // A confirm with no recorded owner is unattributable; treat it as
      // belonging to every session rather than wake past it.
      if (confirm.sessionId === undefined || confirm.sessionId === sessionId) return true;
    }
    return (openForms.get(sessionId)?.size ?? 0) > 0;
  };

  const port: LeaderWakePort = {
    isOpen: (sessionId) => opts.isOpen(sessionId),
    isDisplayed: (sessionId) => opts.isDisplayed(sessionId),
    isIdle: (sessionId) => !opts.abortControllers.has(sessionId),
    hasPendingUserInput: (sessionId) => (pendingSubmits.get(sessionId) ?? 0) > 0,
    isConfirmPending: confirmPending,
    startWakeTurn: async (sessionId, prompt) => {
      if (!starter) throw new Error('no conversation path is bound for auto-wake turns');
      // Resolves once the turn claimed its run lock (or was refused), NOT when
      // it finished: the controller's in-flight flag must not span the run,
      // or its own post-run check would see a wake still "in flight".
      await starter(sessionId, prompt);
    },
  };
  const detachPort = opts.controller.attachPort(port);

  const offs: Array<() => void> = [
    opts.events.on('user.input_requested', (e) => {
      const requestId = (e.request as { id?: unknown } | undefined)?.id;
      if (!e.sessionId || typeof requestId !== 'string') return;
      let set = openForms.get(e.sessionId);
      if (!set) {
        set = new Set();
        openForms.set(e.sessionId, set);
      }
      set.add(requestId);
    }),
    opts.events.on('user.input_resolved', (e) => {
      if (!e.sessionId) return;
      const set = openForms.get(e.sessionId);
      if (!set) return;
      set.delete(e.requestId);
      if (set.size === 0) openForms.delete(e.sessionId);
    }),
    opts.events.on('leader.delivery_pending', (e) => {
      const wanted = new Set(e.deliveryIds);
      const delegationIds = hub
        .peek(e.sessionId)
        .filter((item) => wanted.has(item.deliveryId))
        .map((item) => item.payload.delegationId);
      opts.broadcast({
        type: 'delegation.delivery_pending',
        payload: { sessionId: e.sessionId, count: e.count, delegationIds, wake: e.wake },
      });
    }),
    opts.events.on('leader.auto_wake_started', (e) => {
      opts.broadcast({
        type: 'delegation.auto_wake_started',
        payload: { sessionId: e.sessionId, delegationIds: e.delegationIds, chain: e.chain },
      });
    }),
    opts.events.on('leader.auto_wake_suppressed', (e) => {
      if (e.reason !== 'chain_cap') return;
      opts.broadcast({
        type: 'delegation.auto_wake_suppressed',
        payload: { sessionId: e.sessionId, reason: e.reason, pending: e.pending },
      });
    }),
  ];

  return {
    port,
    onUserMessage: (sessionId) => {
      if (disposed || !sessionId) return () => undefined;
      safely(opts.logger, 'noteUserInput', () => opts.controller.noteUserInput(sessionId));
      pendingSubmits.set(sessionId, (pendingSubmits.get(sessionId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (pendingSubmits.get(sessionId) ?? 1) - 1;
        if (left > 0) pendingSubmits.set(sessionId, left);
        else pendingSubmits.delete(sessionId);
      };
    },
    onRunEnded: (sessionId, info) => {
      // Esc/Stop never cancels background delegations, but a run the user
      // stopped must not be followed by a turn they did not ask for: its
      // results wait for their next message.
      if (disposed || info.aborted) return;
      safely(opts.logger, 'onRunFinished', () => opts.controller.onRunFinished(sessionId));
    },
    bindRuntimeTurnStarter: (start) => {
      starter = start;
      return () => {
        if (starter === start) starter = null;
      };
    },
    onSessionsDisplayed: (sessionIds) => {
      if (disposed) return;
      for (const sessionId of sessionIds) {
        if (!sessionId) continue;
        safely(opts.logger, 'onSessionDisplayed', () =>
          opts.controller.onSessionDisplayed(sessionId),
        );
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      detachPort();
      starter = null;
      pendingSubmits.clear();
      openForms.clear();
    },
  };
}
