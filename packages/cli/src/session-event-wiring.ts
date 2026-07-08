/**
 * session-event-wiring — EventBus subscriptions for session audit logging,
 * error tracking, and file-author recording. Also owns the
 * SessionEventBridge and appendSessionEvent helper that gates on session
 * identity so stale sessions don't pollute the current log.
 *
 * Extracted from cli-main.ts's monolithic main() to reduce cognitive load
 * and enable focused testing.
 */

import { createSessionEventBridge, recordFileAction, resolveSessionLoggingConfig } from '@wrongstack/core';
import type { SessionEventBridge } from '@wrongstack/core';

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
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  session: { id: string };
  sessionRef: { current?: { id: string } | undefined };
  wpaths: { globalRoot: string; projectSlug: string };
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
}

// ── Exported wiring ────────────────────────────────────────────────────────

/** Wire SessionEventBridge, appendSessionEvent, error ring, and tool-lifecycle
 *  session audit events. Returns the sessionBridge (for compaction / audit-level
 *  changes) and the error ring array (for /diag). */
export function wireSessionEvents(deps: WireSessionEventsDeps): WireSessionEventsResult {
  const { evOn, config, context, session, sessionRef, wpaths, projectRoot } = deps;

  // ── SessionEventBridge ──────────────────────────────────────────────────
  const sessionConfig = resolveSessionLoggingConfig(
    config as never as Parameters<typeof resolveSessionLoggingConfig>[0],
  );
  const sessionWriter: () => import('@wrongstack/core').SessionWriter | null | undefined = () =>
    (context as Record<string, unknown>).session as import('@wrongstack/core').SessionWriter | undefined ?? session as unknown as import('@wrongstack/core').SessionWriter;
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
  evOn('error', (e: {
    sessionId?: string | undefined;
    phase: string;
    err: unknown;
  }) => {
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
  evOn('tool.started', (e: {
    sessionId?: string | undefined;
    name: string;
    id: string;
    input: string;
  }) => {
    appendSessionEvent(e.sessionId, {
      type: 'tool_call_start',
      ts: new Date().toISOString(),
      name: e.name,
      id: e.id,
      input: e.input,
    });
  });

  evOn('tool.executed', (e: {
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
        ).catch(() => { /* best-effort */ });
      }
    }
  });

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
  }

  // ── Tool progress forwarding ─────────────────────────────────────────────
  evOn('tool.progress', (e: {
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
      event: { type: String(e.event.type ?? ''), text: String(e.event.text ?? ''), ...(e.event.data ? { data: e.event.data } : {}) } as never,
    });
  });

  // ── Provider events ─────────────────────────────────────────────────────
  evOn('provider.retry', (e: {
    sessionId?: string | undefined;
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  }) => {
    appendSessionEvent(e.sessionId, {
      type: 'provider_retry',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      attempt: e.attempt,
      delayMs: e.delayMs,
      status: e.status,
      description: e.description,
    });
  });

  evOn('provider.error', (e: {
    sessionId?: string | undefined;
    providerId: string;
    status: number;
    description: string;
    retryable?: boolean;
  }) => {
    appendSessionEvent(e.sessionId, {
      type: 'provider_error',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      status: e.status,
      description: e.description,
      retryable: e.retryable ?? false,
    });
  });

  return { errorRing, sessionBridge, appendSessionEvent };
}
