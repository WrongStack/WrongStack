/**
 * The one producer path from a host's EventBus into the project's Chronicle.
 *
 * Every host that runs agents — the CLI/TUI (and the WebUI it embeds) and the
 * standalone WebUI server the desktop engine runs — records the same events
 * through this function, so the Session Story, the Chronicle dashboard and the
 * metrics read the same history whichever surface ran the conversation. The
 * standalone server once had no producer at all: the desktop's stories queried
 * a Chronicle that never heard of its conversations.
 */
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { startNetworkTelemetryMonitor } from '@wrongstack/core/observability';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { toErrorMessage } from '@wrongstack/core/utils';
import { type ChronicleContext, createChronicleContext } from './context.js';
import { createChronicleCounterSink } from './counter-sink.js';
import { wireDecisionsToChronicle } from './decision-adapter.js';
import { resolveChronicleDetail } from './detail-policy.js';
import { wireDomainEventsToChronicle } from './domain-adapter.js';
import { type ChronicleFileObserver, startChronicleFileObserver } from './file-observer.js';
import { startChronicleHealthMonitor } from './health-monitor.js';
import { wireProcessesToChronicle } from './process-adapter.js';
import { type ChronicleEventJournalHandle, createChronicleEventJournal } from './project-access.js';
import { wireProviderAttemptsToChronicle } from './provider-adapter.js';
import { wireReviewFindingsToChronicle } from './review-adapter.js';
import { wireRollupsToChronicle } from './rollup-adapter.js';
import type { ChronicleEventSink } from './sink.js';
import { wireProviderStreamsToChronicle } from './stream-adapter.js';
import { wireToolsToChronicle } from './tool-adapter.js';

const DEFAULT_CHRONICLE_RETENTION_DAYS = 7;

const MIN_CHRONICLE_RETENTION_DAYS = 7;

/** `0` disables auto-purge; positive values are floored at 7 days so a
 *  project-committed config cannot flush recent evidence. */
export function resolveChronicleRetentionDays(config: Record<string, unknown>): number {
  const raw = (config.chronicle as { retentionDays?: unknown } | undefined)?.retentionDays;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CHRONICLE_RETENTION_DAYS;
  if (raw <= 0) return 0;
  return Math.max(MIN_CHRONICLE_RETENTION_DAYS, raw);
}

/** Read a positive numeric `chronicle.*` knob, or undefined to keep the default. */
export function chronicleLimit(config: Record<string, unknown>, key: string): number | undefined {
  const raw = (config.chronicle as Record<string, unknown> | undefined)?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Open the Chronicle journal, or give up on telemetry for this session.
 *
 * `createChronicleEventJournal` fails closed: rather than quietly handing this
 * process its own hash chain when the daemon build cannot be located, it
 * raises. Chronicle is observability, though — losing it must never stop a
 * user from working. So the failure is absorbed here, once, and reported.
 *
 * Note what is *not* done: no silent retry into an inline journal. Telemetry is
 * either recorded by the project's single owner or not recorded at all, and the
 * operator is told which.
 */
export function tryCreateChronicleJournal(
  options: Parameters<typeof createChronicleEventJournal>[0],
): ChronicleEventJournalHandle | undefined {
  try {
    return createChronicleEventJournal(options);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'chronicle.disabled',
        reason: toErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return undefined;
  }
}

export interface ChronicleSessionWiringOptions {
  /** The bus the host's agents emit on; every adapter subscribes to it. */
  events: EventBus;
  /** The live config: `chronicle.retentionDays`, limits and detail level. */
  config: Record<string, unknown>;
  projectRoot: string;
  /** The host's resolved WrongStack paths for the project. */
  paths: {
    globalRoot: string;
    projectSlug: string;
    projectHash?: string | undefined;
    projectDir?: string | undefined;
  };
  /**
   * The session an event without its own `sessionId` belongs to. Events that
   * carry one (every WebUI tab's) are scoped to it instead.
   */
  sessionId: () => string;
  traceId?: string | undefined;
  /** A journal append failed; the host decides how to surface it. */
  onPersistError?: ((error: unknown) => void) | undefined;
}

export interface ChronicleSessionWiring {
  /** The sink every adapter writes through (the collection-policy decorator). */
  journal: ChronicleEventSink;
  /** Whether the project's Chronicle daemon owns the journal. */
  serverBacked: boolean;
  /** Unsubscribes the adapters, drains the counters and closes the journal. */
  dispose(): Promise<void>;
}

/**
 * Subscribe the Chronicle adapters to `events` and open the project's journal.
 * Undefined when the project has no data directory or the journal could not be
 * opened (already reported by {@link tryCreateChronicleJournal}).
 */
export function wireChronicleSession(
  options: ChronicleSessionWiringOptions,
): ChronicleSessionWiring | undefined {
  const { events, config, projectRoot, paths } = options;
  if (!paths.projectDir) return undefined;
  const handle = tryCreateChronicleJournal({
    projectRoot,
    retentionDays: resolveChronicleRetentionDays(config),
    // Undefined means "whatever the daemon already runs with": these only
    // take effect for the client that wins the spawn race, so passing an
    // explicit fallback here would imply a control this layer does not have.
    maxEvents: chronicleLimit(config, 'maxEvents'),
    maxBytes: chronicleLimit(config, 'maxBytes'),
    metricsRowRetentionDays: chronicleLimit(config, 'metricsRowRetentionDays'),
    projectPaths: {
      globalRoot: paths.globalRoot,
      projectId: paths.projectHash ?? paths.projectSlug,
      projectDir: paths.projectDir,
      workspaceId: paths.projectSlug,
    },
  });
  if (!handle) return undefined;
  // Collection policy sits between the adapters and the journal rather than
  // inside any one of them: every adapter already writes through the sink,
  // so one decorator covers all of them and cannot drift per-adapter. At
  // `full` the decorator still runs, but route() keeps everything, so the
  // cost is one predictable branch per append.
  const journal = createChronicleCounterSink({
    inner: handle.journal,
    level: resolveChronicleDetail(config),
  });
  const location = handle.identity;
  const base = createChronicleContext(
    {
      installationId: location.installationId,
      machineId: location.machineId,
      projectId: location.projectId,
      workspaceId: paths.projectSlug,
      sessionId: options.sessionId(),
    },
    options.traceId,
  );
  const context = (): ChronicleContext => ({
    ...base,
    scope: { ...base.scope, sessionId: options.sessionId() },
  });
  const onPersistError = (error: unknown): void => options.onPersistError?.(error);
  const scrubber = new DefaultSecretScrubber();
  const unsubscribers = [
    wireProviderAttemptsToChronicle({ events, journal, context, onPersistError }),
    wireProviderStreamsToChronicle({ events, journal, context, onPersistError }),
    wireToolsToChronicle({ events, journal, context, scrubber, onPersistError }),
    wireProcessesToChronicle({ events, journal, context, scrubber, onPersistError }),
    wireDecisionsToChronicle({ events, journal, context, onPersistError }),
    wireDomainEventsToChronicle({ events, journal, context, onPersistError }),
    wireRollupsToChronicle({ events, journal, context, onPersistError }),
    wireReviewFindingsToChronicle({ events, journal, context, onPersistError }),
  ];
  let fileObserver: Promise<ChronicleFileObserver> | undefined;
  if (!handle.serverBacked) {
    fileObserver = startChronicleFileObserver({
      projectRoot,
      journal,
      events,
      excludedPaths: [location.chronicleDirectory],
      context,
      onError: onPersistError,
    });
    // The observer is optional on filesystems where recursive fs.watch is not
    // available. The error is already surfaced through onPersistError.
    void fileObserver.catch(() => {});
  }
  const stopHealth = startChronicleHealthMonitor({ events, journal, context, onPersistError });
  const stopNetworkTelemetry = startNetworkTelemetryMonitor();
  let disposed: Promise<void> | undefined;
  return {
    journal,
    serverBacked: handle.serverBacked,
    dispose: () => {
      disposed ??= (async () => {
        stopHealth();
        stopNetworkTelemetry();
        for (const unsubscribe of unsubscribers) unsubscribe();
        // Before the handle closes: draining emits the final counter windows, and
        // they have to reach a journal that is still open.
        await journal.dispose();
        if (fileObserver) {
          try {
            await (await fileObserver).close();
          } catch {
            // Start failures were already reported through onPersistError.
          }
        }
        await handle.dispose();
      })();
      return disposed;
    },
  };
}
