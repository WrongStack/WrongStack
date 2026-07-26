/**
 * DirectorCollabController — owns the Director's active collab-debug sessions.
 *
 * Extracted from `Director` (R4): the collab cluster is self-contained — a
 * single `activeSessions` map plus spawn/cancel/alert/list operations over it,
 * using only already-shared deps (the FleetBus, the coordinator's `stop`, and
 * the logger). The Director keeps thin public delegators (`spawnCollab`,
 * `cancelCollabSession`, `onCollabAlert`, `activeCollabSessions`) so its public
 * surface is unchanged.
 */

import type { Logger } from '../../types/logger.js';
import {
  type CollabDebugReport,
  CollabSession,
  type CollabSessionOptions,
  type DirectorAlert,
} from '../collab-debug.js';
import type { CollabDirectorHost } from '../collab-director-host.js';
import type { FleetBus } from '../fleet-bus.js';

/** Minimal slice of the coordinator the controller needs to abort collab agents. */
interface CollabAgentStopper {
  stop(subagentId: string): Promise<void>;
}

interface DirectorCollabControllerDeps {
  /** The owning Director, passed to each CollabSession. */
  director: CollabDirectorHost;
  fleet: FleetBus;
  coordinator: CollabAgentStopper;
  logger?: Logger | undefined;
}

export class DirectorCollabController {
  /** Active collab sessions tracked by sessionId (see spawn).
   *  The tuple holds the session and its Director-registered listener unsubs.
   *  Calling the unsubs on cancel/premature-cleanup prevents listener accumulation
   *  on CollabSession (EventEmitter) across many spawn() calls. */
  private readonly activeSessions = new Map<
    string,
    { session: CollabSession; unsubs: (() => void)[] }
  >();

  constructor(private readonly deps: DirectorCollabControllerDeps) {}

  async spawn(options: CollabSessionOptions): Promise<CollabDebugReport> {
    const session = new CollabSession(this.deps.director, this.deps.fleet, {
      ...options,
      onBudgetWarning: (alert) => {
        // Delegate to the host-provided handler if set; 'ignore' by default.
        // Active collab agents are excluded from the Director's
        // budget.threshold_reached handler via `ownsSubagent`, so the session's
        // own wireFleetBus() budget handler (progress-based timeout logic,
        // session.cancel()) runs instead of the Director's auto-extend/deny.
        return options.onBudgetWarning?.(alert) ?? 'ignore';
      },
    });
    // Track so cancel(sessionId) works and Director knows what's active.
    // Store explicit unsubscribe wrappers so we can detach these listeners on cancel —
    // without cleanup, repeated spawn() calls would accumulate listeners
    // on CollabSession (EventEmitter) for the Director's lifetime.
    // Note: EventEmitter.on() returns `this`, not an unsubscribe function,
    // so we create explicit wrappers that call .off() with the same handler ref.
    const doneHandler = () => this.activeSessions.delete(session.sessionId);
    // session.error fires when start() fails after spawning (partial spawn)
    // or when the awaitTasks race rejects. The handler must stop any agents
    // that were already spawned (getSubagentIds is populated incrementally
    // by spawnAgent) so they don't keep running as orphans, then delete the
    // entry so the controller doesn't retain a dead session forever.
    const errorHandler = () => {
      for (const [_role, subagentId] of session.getSubagentIds()) {
        this.deps.coordinator.stop(subagentId).catch((err) => {
          this.deps.logger?.debug(`stop subagent ${subagentId} failed on session error`, {
            subagentId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      this.activeSessions.delete(session.sessionId);
    };
    session.on('session.done', doneHandler);
    session.on('session.error', errorHandler);
    const unsubs: (() => void)[] = [
      () => session.off('session.done', doneHandler),
      () => session.off('session.error', errorHandler),
    ];
    this.activeSessions.set(session.sessionId, { session, unsubs });
    return session.start();
  }

  cancel(sessionId: string, reason = 'Director cancelled'): void {
    const entry = this.activeSessions.get(sessionId);
    if (!entry || entry.session.isCancelled()) return;
    // NOTE: we intentionally do NOT remove the done/error listeners here.
    // The session's start() is still running (Promise.race on awaitTasks);
    // it will resolve when the stopped agents complete and fire session.done,
    // which deletes this entry from activeSessions. Removing the listeners
    // prematurely (the old behaviour) orphaned the entry — the session
    // finished later but the done handler was already gone, so the entry
    // leaked in activeSessions for the Director's lifetime.
    entry.session.cancel(reason);
    // Stop each collab agent via the coordinator so their run() aborts.
    // This is the critical difference from a natural finish: we call
    // abortController.abort() on each subagent's run signal, which
    // propagates into agent.run() → tool executor and kills the run
    // before the budget or natural iteration limit ends it.
    // The abort is cooperative — the agent finishes its current iteration
    // then sees the signal and exits with status 'aborted', so no context
    // is silently lost.
    for (const [_role, subagentId] of entry.session.getSubagentIds()) {
      this.deps.coordinator.stop(subagentId).catch((err) => {
        this.deps.logger?.debug(`stop subagent ${subagentId} failed (may have already completed)`, {
          subagentId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  onAlert(handler: (alert: DirectorAlert) => void): () => void {
    return this.deps.fleet.filter('collab.warning', (e) => {
      handler(e.payload as DirectorAlert);
    });
  }

  activeSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * True when `subagentId` belongs to a still-active collab-debug session.
   * Used by {@link DirectorBudgetPolicy} so plain `delegate({ role: 'critic' })`
   * spawns (same id prefix, no collab session) still receive auto-extend, while
   * real collab agents keep their session-owned budget handler.
   */
  ownsSubagent(subagentId: string): boolean {
    for (const { session } of this.activeSessions.values()) {
      for (const id of session.getSubagentIds().values()) {
        if (id === subagentId) return true;
      }
    }
    return false;
  }
}
