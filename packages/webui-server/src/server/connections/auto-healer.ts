import type { Logger } from '@wrongstack/core/types';
import type { TrustBoundary } from '@wrongstack/core/security';
import { authorizeWebUIAction } from '../privileged-actions.js';
import { collectConnectionsHealth } from './collector.js';
import { executeServiceAction } from './service-actions.js';
import type {
  ConnectionHealthService,
  ConnectionsHealthReport,
  ServiceActionResult,
} from './types.js';

/**
 * Auto-heal watchdog for /connections IPC services.
 *
 * There is deliberately no retry loop in the /connections layer: the health
 * report is a passive, read-only probe and the RotateCcw button drives the
 * only restart path (`connections.service_action` → `executeServiceAction`).
 * This module turns that same machinery into an opt-in server-side watchdog:
 * on an interval it collects the health report and, for any restartable
 * service stuck in `error`, re-runs the exact restart used by the button
 * (shutdown → wait-for-dead → respawn → ping verification).
 *
 * Trigger contract — status `error` only. `offline` / `unavailable` are the
 * normal sleeping states of on-demand daemons and must never be restarted;
 * `degraded` means the service is serving (inline fallback, quarantine,
 * damaged rows) and should also never trigger a restart.
 */

export const AUTO_HEAL_ENV_FLAG = 'WRONGSTACK_AUTO_HEAL_SERVICES';
const AUTO_HEAL_DEFAULT_INTERVAL_MS = 30_000;
export const AUTO_HEAL_DEFAULT_COOLDOWN_MS = 5 * 60_000;
const AUTO_HEAL_DEFAULT_MAX_ATTEMPTS = 3;

/** Services with a working `executeServiceAction` restart path. */
const RESTARTABLE_SERVICE_IDS = new Set<ConnectionHealthService['id']>([
  'kanban',
  'sage',
  'chronicle',
  'codebase-index',
  'mailbox',
]);

interface AutoHealServiceState {
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  lastSuccess: boolean | null;
  lastMessage: string | null;
  inFlight: boolean;
  escalated: boolean;
}

/** UI-facing event emitted at each healer decision point. */
export type AutoHealStatusPhase = 'restarting' | 'restarted' | 'failed' | 'escalated' | 'refused';

export interface AutoHealStatusEvent {
  serviceId: ConnectionHealthService['id'] | null;
  phase: AutoHealStatusPhase;
  message: string;
  at: number;
  /** 1-based attempt number within the current failure streak. */
  attempt: number;
}

interface AutoHealSnapshot {
  enabled: boolean;
  running: boolean;
  lastTickAt: number | null;
  services: Record<string, AutoHealServiceState>;
}

interface AutoHealerOptions {
  projectRoot: () => string;
  indexDir: () => string | undefined;
  /** Policy boundary. When absent, auto-heal refuses to act (same rule as the manual WS path). */
  trustBoundary?: TrustBoundary | undefined;
  logger?: Logger | undefined;
  /**
   * UI visibility hook. The wiring layer forwards these to the WebSocket
   * broadcast as `connections.auto_heal_status` so clients can render an
   * "auto-restarting…" state instead of silently flipping statuses.
   */
  onStatus?: ((event: AutoHealStatusEvent) => void) | undefined;
  /** Health collector override (tests). Defaults to the real per-project collector. */
  collect?: () => Promise<ConnectionsHealthReport>;
  /** Restart executor override (tests). Defaults to the button's `executeServiceAction`. */
  execute?: (
    serviceId: ConnectionHealthService['id'],
    action: 'restart',
    projectRoot: string,
    indexDir: string | undefined,
  ) => Promise<ServiceActionResult>;
  /** Enable override. Defaults to the `WRONGSTACK_AUTO_HEAL_SERVICES` env flag. */
  enabled?: boolean;
  intervalMs?: number;
  cooldownMs?: number;
  maxAttempts?: number;
}

interface AutoHealer {
  start(): void;
  stop(): void;
  /**
   * Idempotent teardown: stops the interval and waits for any in-flight tick
   * (including a restart in progress) to finish. No new restart is started
   * after disposal begins. Safe to call multiple times and when never started.
   */
  dispose(): Promise<void>;
  tick(): Promise<AutoHealSnapshot>;
  getSnapshot(): AutoHealSnapshot;
  isRunning(): boolean;
}

export function isAutoHealEnabled(): boolean {
  return process.env[AUTO_HEAL_ENV_FLAG] === '1';
}

export function createAutoHealer(options: AutoHealerOptions): AutoHealer {
  const enabled = options.enabled ?? isAutoHealEnabled();
  const intervalMs = options.intervalMs ?? AUTO_HEAL_DEFAULT_INTERVAL_MS;
  const cooldownMs = options.cooldownMs ?? AUTO_HEAL_DEFAULT_COOLDOWN_MS;
  const maxAttempts = options.maxAttempts ?? AUTO_HEAL_DEFAULT_MAX_ATTEMPTS;
  const collect =
    options.collect ??
    (() =>
      collectConnectionsHealth({
        projectRoot: options.projectRoot(),
        indexDir: options.indexDir(),
        backend: 'standalone',
      }));
  const execute = options.execute ?? executeServiceAction;

  const services = new Map<string, AutoHealServiceState>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;
  let disposed = false;
  let inFlightTick: Promise<unknown> | null = null;
  let lastTickAt: number | null = null;
  let warnedNoBoundary = false;

  function stateFor(serviceId: string): AutoHealServiceState {
    let state = services.get(serviceId);
    if (!state) {
      state = {
        lastAttemptAt: null,
        consecutiveFailures: 0,
        lastSuccess: null,
        lastMessage: null,
        inFlight: false,
        escalated: false,
      };
      services.set(serviceId, state);
    }
    return state;
  }

  function snapshot(): AutoHealSnapshot {
    return {
      enabled,
      running,
      lastTickAt,
      services: Object.fromEntries(services),
    };
  }

  /** Forward a UI-facing status event; a throwing hook never breaks the heal loop. */
  function emitStatus(event: Omit<AutoHealStatusEvent, 'at'>): void {
    try {
      options.onStatus?.({ ...event, at: Date.now() });
    } catch (error) {
      options.logger?.warn?.(
        `[AutoHeal] onStatus hook threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function tick(): Promise<AutoHealSnapshot> {
    if (!enabled || disposed) return snapshot();
    if (!options.trustBoundary) {
      if (!warnedNoBoundary) {
        warnedNoBoundary = true;
        options.logger?.warn?.(
          '[AutoHeal] Disabled: no policy authority (trust boundary) is configured.',
        );
      }
      return snapshot();
    }
    if (ticking) return snapshot(); // single-flight: never run two ticks concurrently

    ticking = true;
    try {
      const report = await collect();
      const now = Date.now();
      const projectRoot = options.projectRoot();
      const indexDir = options.indexDir();

      for (const service of report.services) {
        // Once disposed, never start (or wait to authorize) another restart.
        if (disposed) break;
        const state = stateFor(service.id);

        // A service back to non-error (manual restart, respawn on use, or a
        // transient fault) re-arms the watchdog: clear the failure streak.
        if (service.status !== 'error') {
          state.consecutiveFailures = 0;
          state.escalated = false;
          continue;
        }

        if (!RESTARTABLE_SERVICE_IDS.has(service.id) || service.control === 'none') {
          continue;
        }
        if (state.lastAttemptAt !== null && now - state.lastAttemptAt < cooldownMs) continue;
        if (state.consecutiveFailures >= maxAttempts) {
          state.escalated = true;
          options.logger?.warn?.(
            `[AutoHeal] ${service.id} left to manual intervention after ${state.consecutiveFailures} failed auto-restart(s): ${state.lastMessage ?? 'unknown'}`,
          );
          continue;
        }
        if (state.inFlight) continue;

        const authorization = await authorizeWebUIAction(
          options.trustBoundary,
          {
            capability: 'connections.service.restart',
            subject: { kind: 'process', id: `${service.id}@${projectRoot}` },
            risk: 'elevated',
            cwd: projectRoot,
            metadata: { transport: 'auto-heal', serviceId: service.id, action: 'restart' },
          },
          options.logger,
        );
        // Disposal can begin while the authorization await was pending;
        // never start (or emit) a new restart once shutdown has begun.
        if (disposed) break;
        if (!authorization.allowed) {
          state.lastAttemptAt = now;
          state.lastMessage = `refused by policy: ${authorization.reason}`;
          emitStatus({
            serviceId: service.id,
            phase: 'refused',
            message: `refused by policy: ${authorization.reason}`,
            attempt: state.consecutiveFailures + 1,
          });
          options.logger?.warn?.(
            `[AutoHeal] ${service.id} restart refused by policy: ${authorization.reason}`,
          );
          continue;
        }

        state.inFlight = true;
        const attempt = state.consecutiveFailures + 1;
        emitStatus({
          serviceId: service.id,
          phase: 'restarting',
          message: `Auto-restarting ${service.id}`,
          attempt,
        });
        try {
          const result = await execute(service.id, 'restart', projectRoot, indexDir);
          state.consecutiveFailures = result.success ? 0 : state.consecutiveFailures + 1;
          state.lastSuccess = result.success;
          state.lastMessage = result.message;
          emitStatus({
            serviceId: service.id,
            phase: result.success ? 'restarted' : 'failed',
            message: result.message,
            attempt,
          });
          if (!result.success && state.consecutiveFailures >= maxAttempts) {
            state.escalated = true;
            emitStatus({
              serviceId: service.id,
              phase: 'escalated',
              message: `left to manual intervention after ${state.consecutiveFailures} failed auto-restart(s): ${result.message}`,
              attempt,
            });
            options.logger?.warn?.(
              `[AutoHeal] ${service.id} escalated after ${state.consecutiveFailures} failed auto-restart(s): ${result.message}`,
            );
          }
          options.logger?.[result.success ? 'info' : 'warn']?.(
            `[AutoHeal] ${service.id} auto-restart ${result.success ? 'succeeded' : 'failed'}: ${result.message}`,
          );
        } catch (error) {
          state.consecutiveFailures += 1;
          state.lastSuccess = false;
          state.lastMessage = error instanceof Error ? error.message : String(error);
          emitStatus({
            serviceId: service.id,
            phase: 'failed',
            message: state.lastMessage,
            attempt,
          });
          if (state.consecutiveFailures >= maxAttempts) {
            state.escalated = true;
            emitStatus({
              serviceId: service.id,
              phase: 'escalated',
              message: `left to manual intervention after ${state.consecutiveFailures} failed auto-restart(s): ${state.lastMessage}`,
              attempt,
            });
            options.logger?.warn?.(
              `[AutoHeal] ${service.id} escalated after ${state.consecutiveFailures} failed auto-restart(s): ${state.lastMessage}`,
            );
          }
          options.logger?.warn?.(
            `[AutoHeal] ${service.id} auto-restart threw: ${state.lastMessage}`,
          );
        } finally {
          state.lastAttemptAt = Date.now();
          state.inFlight = false;
        }
      }

      lastTickAt = Date.now();
    } catch (error) {
      options.logger?.warn?.(
        `[AutoHeal] health collect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      ticking = false;
    }
    return snapshot();
  }

  /** Run a tick and remember it so `dispose()` can drain it. */
  function runTick(): void {
    if (!enabled || disposed || running === false || ticking) return;
    const pending = tick();
    const tracked: Promise<unknown> = pending.then(
      () => undefined,
      () => undefined,
    );
    inFlightTick = tracked;
    void tracked.finally(() => {
      if (inFlightTick === tracked) inFlightTick = null;
    });
  }

  function stopInternal(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  return {
    start() {
      if (!enabled || running || disposed) return;
      running = true;
      // First pass immediately — don't wait a full interval for the first heal.
      runTick();
      timer = setInterval(runTick, intervalMs);
      timer.unref?.();
    },
    stop: stopInternal,
    async dispose(): Promise<void> {
      stopInternal();
      disposed = true;
      // Drain: wait for an in-flight tick (including any restart in
      // progress) to settle before shutdown proceeds. Bounded — a wedged
      // daemon cannot hang the process teardown forever.
      const pending = inFlightTick;
      if (pending) {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 30_000);
            // Referenced timeouts keep the Node process alive; hosts bound
            // their disposal window tighter than our drain deadline (the CLI
            // embedded host allows ~5s), so this safety net must never
            // outlive the process it is failing to drain.
            t.unref?.();
          }),
        ]);
      }
      disposed = true;
    },
    tick,
    getSnapshot: snapshot,
    isRunning: () => running,
  };
}
