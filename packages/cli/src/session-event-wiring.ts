/**
 * session-event-wiring — EventBus subscriptions for session audit logging,
 * error tracking, and file-author recording. Also owns the
 * SessionEventBridge and appendSessionEvent helper that gates on session
 * identity so stale sessions don't pollute the current log.
 *
 * Extracted from cli-main.ts's monolithic main() to reduce cognitive load
 * and enable focused testing.
 */

import type {
  ChronicleEventJournalHandle,
  ChronicleEventSink,
  ChronicleFileObserver,
} from '@wrongstack/core/chronicle';
import {
  createChronicleContext,
  createChronicleEventJournal,
  startChronicleFileObserver,
  startChronicleHealthMonitor,
  wireDecisionsToChronicle,
  wireDomainEventsToChronicle,
  wireProcessesToChronicle,
  wireProviderAttemptsToChronicle,
  wireProviderStreamsToChronicle,
  wireReviewFindingsToChronicle,
  wireRollupsToChronicle,
  wireToolsToChronicle,
} from '@wrongstack/core/chronicle';
import { recordFileAction } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { startNetworkTelemetryMonitor } from '@wrongstack/core/observability';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import { createSessionEventBridge, resolveSessionLoggingConfig } from '@wrongstack/core/storage';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ErrorEntry {
  ts: string;
  phase: string;
  code: string;
  message: string;
}

export interface WireSessionEventsDeps {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic EventBus dispatch
  evOn: (event: string, handler: (...args: any[]) => void) => void;
  /** Concrete bus is required for Chronicle lifecycle subscriptions. */
  events?: EventBus | undefined;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  session: { id: string };
  sessionRef: { current?: { id: string } | undefined };
  wpaths: {
    globalRoot: string;
    projectSlug: string;
    projectHash?: string | undefined;
    projectDir?: string | undefined;
  };
  projectRoot: string;
  renderer?: { writeInfo?: (msg: string) => void };
  tuiOwnsScreen?: boolean;
}

export interface WireSessionEventsResult {
  errorRing: ErrorEntry[];
  sessionBridge: SessionEventBridge;
  appendSessionEvent: (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ) => void;
  chronicleJournal?: ChronicleEventSink | undefined;
  disposeChronicle: () => Promise<void>;
}

// ── Chronicle retention ───────────────────────────────────────────────────

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
function tryCreateChronicleJournal(
  options: Parameters<typeof createChronicleEventJournal>[0],
): ChronicleEventJournalHandle | undefined {
  try {
    return createChronicleEventJournal(options);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'chronicle.disabled',
        reason: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return undefined;
  }
}

// ── Exported wiring ────────────────────────────────────────────────────────

/** Wire SessionEventBridge, appendSessionEvent, error ring, and tool-lifecycle
 *  session audit events. Returns the sessionBridge (for compaction / audit-level
 *  changes) and the error ring array (for /diag). */
export function wireSessionEvents(deps: WireSessionEventsDeps): WireSessionEventsResult {
  const { evOn, config, context, session, sessionRef, wpaths, projectRoot } = deps;

  // ── SessionEventBridge ──────────────────────────────────────────────────
  const sessionConfig = resolveSessionLoggingConfig(config);
  const sessionWriter: () => import('@wrongstack/core/types').SessionWriter | null | undefined =
    () =>
      ((context as Record<string, unknown>).session as
        | import('@wrongstack/core/types').SessionWriter
        | undefined) ?? (session as unknown as import('@wrongstack/core/types').SessionWriter);
  const sessionBridge: SessionEventBridge = createSessionEventBridge(
    sessionWriter,
    sessionConfig.auditLevel,
    { sampling: sessionConfig.sampling },
  );
  const currentSessionId = (): string => {
    const ctxSess = (context as Record<string, { id: string } | undefined>).session;
    return ctxSess?.id ?? sessionRef.current?.id ?? session.id;
  };
  const isCurrentSession = (sessionId?: string | undefined): boolean =>
    !sessionId || sessionId === currentSessionId();
  const appendSessionEvent = (
    sid: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ): void => {
    if (!isCurrentSession(sid)) return;
    sessionBridge.append(event).catch(() => {
      // best-effort, never block on session logging
    });
  };

  // ── Error ring ──────────────────────────────────────────────────────────
  const errorRing: ErrorEntry[] = [];

  // ── Chronicle durable provider-attempt journal ─────────────────────────
  let chronicleJournal: ChronicleEventSink | undefined;
  let chronicleHandle: ChronicleEventJournalHandle | undefined;
  let unsubscribeChronicle: (() => void) | undefined;
  let chronicleFileObserver: Promise<ChronicleFileObserver> | undefined;
  let stopChronicleHealth: (() => void) | undefined;
  let stopNetworkTelemetry: (() => void) | undefined;
  // Chronicle refuses to run in-process unless asked, so a missing build now
  // raises instead of silently giving this session a private hash chain. That
  // is the right call for the journal's integrity but the wrong call for the
  // session: telemetry is not load-bearing, and a user should never be unable
  // to work because a daemon binary is absent. Degrade loudly to no telemetry.
  if (deps.events && wpaths.projectDir) {
    const retentionDays = resolveChronicleRetentionDays(config);
    chronicleHandle = tryCreateChronicleJournal({
      projectRoot,
      retentionDays,
      projectPaths: {
        globalRoot: wpaths.globalRoot,
        projectId: wpaths.projectHash ?? wpaths.projectSlug,
        projectDir: wpaths.projectDir,
        workspaceId: wpaths.projectSlug,
      },
    });
  }

  if (chronicleHandle && deps.events) {
    chronicleJournal = chronicleHandle.journal;
    const location = chronicleHandle.identity;
    const chronicleContext = createChronicleContext(
      {
        installationId: location.installationId,
        machineId: location.machineId,
        projectId: location.projectId,
        workspaceId: wpaths.projectSlug,
        sessionId: currentSessionId(),
      },
      (context as { traceId?: string | undefined }).traceId,
    );
    const onChroniclePersistError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      errorRing.push({
        ts: new Date().toISOString(),
        phase: 'chronicle.persist',
        code: 'CHRONICLE_PERSIST_FAILED',
        message,
      });
      if (errorRing.length > 5) errorRing.shift();
    };
    const unsubscribeProviderChronicle = wireProviderAttemptsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeStreamChronicle = wireProviderStreamsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeToolChronicle = wireToolsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      scrubber: new DefaultSecretScrubber(),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeProcessChronicle = wireProcessesToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      scrubber: new DefaultSecretScrubber(),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeDecisionChronicle = wireDecisionsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeDomainChronicle = wireDomainEventsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeRollups = wireRollupsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    const unsubscribeReviewFindings = wireReviewFindingsToChronicle({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    unsubscribeChronicle = () => {
      unsubscribeProviderChronicle();
      unsubscribeStreamChronicle();
      unsubscribeToolChronicle();
      unsubscribeProcessChronicle();
      unsubscribeDecisionChronicle();
      unsubscribeDomainChronicle();
      unsubscribeRollups();
      unsubscribeReviewFindings();
    };
    if (!chronicleHandle.serverBacked) {
      chronicleFileObserver = startChronicleFileObserver({
        projectRoot,
        journal: chronicleJournal,
        events: deps.events,
        excludedPaths: [location.chronicleDirectory],
        context: () => ({
          ...chronicleContext,
          scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
        }),
        onError: onChroniclePersistError,
      });
      // The observer is optional on filesystems where recursive fs.watch is not
      // available. The error is already surfaced through the Chronicle ring.
      void chronicleFileObserver.catch(() => {});
    }
    stopChronicleHealth = startChronicleHealthMonitor({
      events: deps.events,
      journal: chronicleJournal,
      context: () => ({
        ...chronicleContext,
        scope: { ...chronicleContext.scope, sessionId: currentSessionId() },
      }),
      onPersistError: onChroniclePersistError,
    });
    stopNetworkTelemetry = startNetworkTelemetryMonitor();
  }
  evOn('error', (e: { sessionId?: string | undefined; phase: string; err: unknown }) => {
    const err = e.err as unknown;
    const code =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    const message = e.err instanceof Error ? e.err.message : String(e.err);
    const ts = new Date().toISOString();
    errorRing.push({ ts, phase: e.phase, code, message });
    if (errorRing.length > 5) errorRing.shift();
    appendSessionEvent(e.sessionId, { type: 'error', ts, message, phase: e.phase });
  });

  // ── Tool lifecycle ──────────────────────────────────────────────────────
  evOn(
    'tool.started',
    (e: { sessionId?: string | undefined; name: string; id: string; input: string }) => {
      appendSessionEvent(e.sessionId, {
        type: 'tool_call_start',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        input: e.input,
      });
    },
  );

  evOn(
    'tool.executed',
    (e: {
      sessionId?: string | undefined;
      name: string;
      id?: string | undefined;
      durationMs?: number | undefined;
      outputBytes?: number | undefined;
      outputTokens?: number | undefined;
      outputLines?: number | undefined;
      ok?: boolean | undefined;
      input?: Record<string, unknown>;
    }) => {
      appendSessionEvent(e.sessionId, {
        type: 'tool_call_end',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id ?? '',
        durationMs: e.durationMs ?? 0,
        outputSize: e.outputBytes ?? 0,
        ok: e.ok,
        outputBytes: e.outputBytes ?? 0,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
      });

      // ── File-author tracking ──────────────────────────────────────────────
      if (
        e.ok &&
        (e.name === 'write' || e.name === 'edit' || e.name === 'replace' || e.name === 'patch')
      ) {
        const filePath = (e.input as Record<string, unknown>)?.path as string | undefined;
        if (filePath) {
          void recordFileAction(
            { storageDir: `${wpaths.globalRoot}/projects/${wpaths.projectSlug}`, projectRoot },
            {
              filePath,
              action: e.name === 'write' ? 'create' : 'edit',
              agentId: 'leader',
              agentName: 'Leader',
              sessionId: currentSessionId(),
            },
          ).catch(() => {
            /* best-effort */
          });
        }
      }
    },
  );

  // ── Delegate lifecycle (non-TUI only) ────────────────────────────────────
  if (!deps.tuiOwnsScreen && deps.renderer?.writeInfo) {
    evOn('delegate.started', (e: { task: string; target: string }) => {
      const task = e.task.length > 100 ? `${e.task.slice(0, 99)}…` : e.task;
      deps.renderer!.writeInfo!(`🤝 Delegating → ${e.target}: ${task}`);
    });
    evOn('delegate.completed', (e: { ok: boolean; summary: string; costUsd?: number }) => {
      const cost = e.costUsd && e.costUsd > 0 ? ` · ${e.costUsd.toFixed(4)}` : '';
      deps.renderer!.writeInfo!(`${e.ok ? '✅' : '❌'} ${e.summary}${cost}`);
    });

    // Loop detection had no subscriber outside tests, so a run the detector
    // cut came back as a bare `max_iterations` with no stated cause. Only
    // `action: 'cut'` surfaces: a 'steer' is an in-band nudge the model
    // absorbs on its own, and announcing it would be noise.
    evOn(
      'tool.loop_detected',
      (e: {
        tools: string;
        repeatCount: number;
        kind?: string | undefined;
        action?: string | undefined;
      }) => {
        if (e.action !== 'cut') return;
        const what =
          e.kind === 'message' ? 'the same reply' : e.tools ? `\`${e.tools}\`` : 'the same step';
        deps.renderer!.writeInfo!(
          `🔁 Loop detected — ${what} repeated ${e.repeatCount}× ; the run was stopped.`,
        );
      },
    );
  }

  // ── Tool progress forwarding ─────────────────────────────────────────────
  evOn(
    'tool.progress',
    (e: {
      sessionId?: string | undefined;
      name: string;
      id: string;
      event: Record<string, unknown>;
    }) => {
      appendSessionEvent(e.sessionId, {
        type: 'tool_progress',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        event: {
          type: String(e.event.type ?? ''),
          text: String(e.event.text ?? ''),
          ...(e.event.data ? { data: e.event.data } : {}),
        } as never,
      });
    },
  );

  // ── Provider events ─────────────────────────────────────────────────────
  evOn(
    'provider.retry',
    (e: {
      sessionId?: string | undefined;
      providerId: string;
      attempt: number;
      delayMs: number;
      status: number;
      description: string;
      errorBody?: import('@wrongstack/core/types').ProviderErrorBody | undefined;
    }) => {
      appendSessionEvent(e.sessionId, {
        type: 'provider_retry',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        attempt: e.attempt,
        delayMs: e.delayMs,
        status: e.status,
        description: e.description,
        ...(e.errorBody ? { errorBody: e.errorBody } : {}),
      });
    },
  );

  evOn(
    'provider.error',
    (e: {
      sessionId?: string | undefined;
      providerId: string;
      status: number;
      description: string;
      retryable?: boolean;
      errorBody?: import('@wrongstack/core/types').ProviderErrorBody | undefined;
    }) => {
      appendSessionEvent(e.sessionId, {
        type: 'provider_error',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        status: e.status,
        description: e.description,
        retryable: e.retryable ?? false,
        ...(e.errorBody ? { errorBody: e.errorBody } : {}),
      });
    },
  );

  const disposeChronicle = async (): Promise<void> => {
    stopChronicleHealth?.();
    stopNetworkTelemetry?.();
    unsubscribeChronicle?.();
    if (chronicleFileObserver) {
      try {
        await (await chronicleFileObserver).close();
      } catch {
        // Start failures were already recorded by onChroniclePersistError.
      }
    }
    await chronicleHandle?.dispose();
  };

  return { errorRing, sessionBridge, appendSessionEvent, chronicleJournal, disposeChronicle };
}
