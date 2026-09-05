/**
 * One HQ session per open WebUI tab.
 *
 * The WebUI runs four concurrent sessions — one Agent, one journal and one
 * abort controller per tab — but HQ only ever heard about the boot session,
 * because the presence layer started a single telemetry bridge for it. So a
 * fleet dashboard watching a four-tab WebUI saw one terminal, and the three
 * others were invisible: no node, no transcript, no way to steer them.
 *
 * This manager keeps a bridge (and the session-scoped agent tracker that feeds
 * it) alive for exactly the set of sessions the connected browsers are
 * displaying, starting and stopping them as tabs open and close.
 *
 * Two things make the per-session tracker possible at all, and both are
 * pre-existing invariants rather than anything introduced here:
 *
 *  - every agent-loop event is stamped with its session (`resolveEventSessionId`),
 *    which is what the WebUI's own lane routing already relies on;
 *  - `AgentStatusTracker` accepts a `sessionId` and drops events belonging to
 *    another one, so several trackers can share the host's single event bus.
 *
 * @module server/hq-session-telemetry
 */

import { AgentStatusTracker } from '@wrongstack/core/coordination';
import type { HqPublisher } from '@wrongstack/core/hq';
import { startSessionTelemetryBridge } from '@wrongstack/core/hq';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SessionWriter } from '@wrongstack/core/types';

export interface WebuiHqSessionTelemetryOptions {
  events: EventBus;
  projectRoot: string;
  projectName: string;
  /** Root the session JSONL is resolved under, for the transcript tail. */
  globalRoot?: string | undefined;
  /** The live publisher, read lazily — it is replaced across reconnects. */
  getPublisher: () => HqPublisher | undefined;
  /** Session ids the connected browsers are currently displaying. */
  listSessions: () => readonly string[];
  /**
   * Sessions another publisher in this process already announces.
   *
   * In the CLI-hosted host, `cli-main` runs its own tracker and bridge for the
   * boot session; announcing it twice would put two trackers on one bus
   * flushing the same agent list.
   */
  isOwnedElsewhere?: ((sessionId: string) => boolean) | undefined;
  /**
   * The tab's own session writer, when the host holds one.
   *
   * Lets the bridge take turns straight from the write path instead of tailing
   * the JSONL. Optional: without it the bridge falls back to the disk tail.
   */
  getWriter?: ((sessionId: string) => SessionWriter | undefined) | undefined;
}

export interface WebuiHqSessionTelemetry {
  /** Reconcile the live bridges against `listSessions()`. Idempotent. */
  sync(): void;
  /** Session ids with a live bridge. Exposed for tests and diagnostics. */
  active(): string[];
  stop(): void;
}

/**
 * Cross-process presence is not this tracker's job.
 *
 * The shared registry holds ONE entry per process, owned by the boot session's
 * tracker. A per-tab tracker writing to it would overwrite that entry with its
 * own agents. These trackers exist purely to feed `session.agents_updated` for
 * their session's HQ bridge, so the registry write is dropped.
 */
const NO_REGISTRY = { updateAgents: async (): Promise<void> => undefined };

export function startWebuiHqSessionTelemetry(
  options: WebuiHqSessionTelemetryOptions,
): WebuiHqSessionTelemetry {
  interface Entry {
    tracker: AgentStatusTracker;
    stopBridge: () => void;
  }
  const entries = new Map<string, Entry>();
  let stopped = false;

  const start = (sessionId: string): void => {
    const publisher = options.getPublisher();
    if (publisher === undefined) return;
    const tracker = new AgentStatusTracker({
      events: options.events,
      registry: NO_REGISTRY,
      sessionId,
    });
    tracker.start();
    let stopBridge: () => void;
    try {
      const writer = options.getWriter?.(sessionId);
      stopBridge = startSessionTelemetryBridge({
        publisher,
        events: options.events,
        sessionId,
        projectRoot: options.projectRoot,
        projectName: options.projectName,
        startedAt: new Date().toISOString(),
        initialAgents: tracker.getAgents(),
        ...(options.globalRoot !== undefined ? { globalRoot: options.globalRoot } : {}),
        ...(writer !== undefined ? { writer } : {}),
      });
    } catch {
      // Telemetry is best-effort; a failed bridge must not leave its tracker
      // subscribed to the host's bus for the life of the process.
      tracker.stop();
      return;
    }
    entries.set(sessionId, { tracker, stopBridge });
  };

  const stopEntry = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (entry === undefined) return;
    entries.delete(sessionId);
    try {
      // Publishes `session.ended`, which is what removes the node from HQ
      // rather than leaving it to the five-minute staleness reaper.
      entry.stopBridge();
    } catch {
      /* best-effort */
    }
    try {
      entry.tracker.stop();
    } catch {
      /* best-effort */
    }
  };

  const sync = (): void => {
    if (stopped) return;
    const wanted = new Set<string>();
    for (const sessionId of options.listSessions()) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      if (options.isOwnedElsewhere?.(sessionId) === true) continue;
      wanted.add(sessionId);
    }
    for (const sessionId of [...entries.keys()]) {
      if (!wanted.has(sessionId)) stopEntry(sessionId);
    }
    for (const sessionId of wanted) {
      if (!entries.has(sessionId)) start(sessionId);
    }
  };

  return {
    sync,
    active: () => [...entries.keys()],
    stop: () => {
      stopped = true;
      for (const sessionId of [...entries.keys()]) stopEntry(sessionId);
    },
  };
}
