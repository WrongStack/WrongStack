import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SubagentConfig, TokenCounter, Usage } from '@wrongstack/core/types';

const BRIDGE_TEXT_CAP = 360;
const BRIDGE_OUTPUT_CAP = 4_096;

function compactText(value: string, cap = BRIDGE_TEXT_CAP): string {
  return value.length <= cap ? value : `${value.slice(0, cap - 1)}…`;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function patchDelta(value: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  const hunkStart = value.indexOf('@@');
  if (hunkStart === -1) return { addedLines, removedLines };
  for (const line of value.slice(hunkStart).split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines += 1;
    else if (line.startsWith('-')) removedLines += 1;
  }
  return { addedLines, removedLines };
}

/**
 * Bound tool inputs before they cross from a subagent EventBus into the host.
 * File bodies and patches can be multi-megabyte; the host only needs their
 * metadata and size/line signals for live activity views.
 */
export function compactBridgeToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return typeof input === 'string' ? compactText(input) : input;
  }

  const source = input as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'filename',
    'target_file',
    'targetFile',
    'line',
    'start_line',
    'startLine',
    'end_line',
    'endLine',
    'offset',
    'limit',
    'command',
    'cmd',
    'url',
    'href',
    'uri',
    'query',
    'pattern',
  ]) {
    const value = source[key];
    if (typeof value === 'string') compact[key] = compactText(value);
    else if (typeof value === 'number' || typeof value === 'boolean') compact[key] = value;
  }

  const content = [source['content'], source['text'], source['data']].find(
    (value): value is string => typeof value === 'string',
  );
  const oldText = [source['old_string'], source['oldString'], source['search']].find(
    (value): value is string => typeof value === 'string',
  );
  const newText = [source['new_string'], source['newString'], source['replacement']].find(
    (value): value is string => typeof value === 'string',
  );
  const patch = [source['patch'], source['diff']].find(
    (value): value is string => typeof value === 'string',
  );
  const bodies = [content, oldText, newText, patch].filter(
    (value): value is string => value !== undefined,
  );
  if (bodies.length > 0) {
    compact['_bodyBytes'] = bodies.reduce(
      (total, value) => total + Buffer.byteLength(value, 'utf8'),
      0,
    );
  }
  if (content !== undefined) compact['inputLines'] = lineCount(content);
  if (oldText !== undefined) compact['oldLines'] = lineCount(oldText);
  if (newText !== undefined) compact['newLines'] = lineCount(newText);
  if (patch !== undefined) {
    const delta = patchDelta(patch);
    compact['addedLines'] = delta.addedLines;
    compact['removedLines'] = delta.removedLines;
  }
  return compact;
}

function compactBridgeToolOutput(output: string | undefined): string | undefined {
  return output === undefined ? undefined : compactText(output, BRIDGE_OUTPUT_CAP);
}

export function installSubagentEventBridge(opts: {
  events: EventBus;
  hostEvents: EventBus;
  hostSessionId: string;
  projectRoot: string;
  effectiveCfg: SubagentConfig;
  subCfg: SubagentConfig;
  /** The subagent's own counter, for the cumulative snapshot on each emit. */
  tokenCounter?: Pick<TokenCounter, 'total'> | undefined;
  /** Routed provider/model, used when an event omits its own. */
  subagentProvider?: string | undefined;
  subagentModel?: string | undefined;
}): () => void {
  const {
    events,
    hostEvents,
    hostSessionId,
    projectRoot,
    effectiveCfg,
    subCfg,
    tokenCounter,
    subagentProvider,
    subagentModel,
  } = opts;
  const subagentId = (): string => effectiveCfg.id ?? effectiveCfg.name ?? 'subagent';
  const agentName = (name?: string | undefined): string => name ?? subCfg.name;

  const offToolStartedBridge = events.on('tool.started', (e) => {
    hostEvents.emit('subagent.tool_started', {
      sessionId: hostSessionId,
      agentSessionId: e.sessionId,
      subagentId: subagentId(),
      agentName: agentName(e.agentName),
      traceId: e.traceId,
      id: e.id,
      name: e.name,
      input: compactBridgeToolInput(e.input),
    });
  });

  const offToolProgressBridge = events.on('tool.progress', (e) => {
    if (e.event.type !== 'file_changed') return;
    const rawPath =
      e.event.path ??
      (typeof e.event.data?.['path'] === 'string' ? e.event.data['path'] : undefined);
    if (!rawPath) return;
    const filePath = path.normalize(
      path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath),
    );
    hostEvents.emit('file.activity', {
      filePath,
      operation: e.event.operation ?? 'edit',
      phase: 'changed',
      source: 'deterministic',
      at: Date.now(),
      sessionId: e.sessionId,
      traceId: e.traceId,
      agentId: subagentId(),
      agentName: agentName(e.agentName),
      toolUseId: e.id,
      toolName: e.name,
      line: e.event.line,
      endLine: e.event.endLine,
    });
  });

  const offToolBridge = events.on('tool.executed', (e) => {
    hostEvents.emit('subagent.tool_executed', {
      sessionId: hostSessionId,
      agentSessionId: e.sessionId,
      subagentId: subagentId(),
      agentName: agentName(e.agentName),
      traceId: e.traceId,
      id: e.id,
      name: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
      input: compactBridgeToolInput(e.input),
      output: compactBridgeToolOutput(e.output),
      outputBytes: e.outputBytes,
      outputTokens: e.outputTokens,
      outputLines: e.outputLines,
    });
  });

  const offSummaryBridge = events.on('subagent.iteration_summary', (e) => {
    hostEvents.emit('subagent.iteration_summary', {
      ...e,
      sessionId: hostSessionId,
      subagentId: subagentId(),
    });
  });

  const offCtxBridge = events.on('ctx.pct', (e) => {
    hostEvents.emit('subagent.ctx_pct', {
      sessionId: hostSessionId,
      subagentId: subagentId(),
      load: e.load,
      tokens: e.tokens,
      maxContext: e.maxContext,
    });
  });

  // ── Token + provider attribution ────────────────────────────────────────
  // These are the events that made subagent spend invisible. Chronicle's
  // adapters subscribe to the HOST bus; a subagent's `token.accounted` and
  // `provider.attempt.*` are emitted on its private bus and stopped there. A
  // 287 MB journal held 2,402 `token.accounted` rows and 2,033
  // `provider.attempt.completed` rows — every single one attributed to the
  // leader, while 419 distinct subagents showed up in the `subagent.*` family
  // with no spend or reliability data attached to any of them.
  //
  // Re-namespaced rather than re-emitted verbatim, for the same reason
  // `tool.executed` becomes `subagent.tool_executed` above: host subscribers
  // of `provider.attempt.*` and `token.accounted` (statusline, cost bridge,
  // fallback management, the leader's own status tracker) treat them as
  // LEADER activity. Replaying subagent events under those names would make
  // the leader's own numbers wrong to fix the subagents'. Chronicle's domain
  // adapter picks the new names up through the `subagent.` prefix and reads
  // `subagentId` into `scope.agentId` plus `provider`/`model` into `runtime`.
  const offTokenBridge = events.on('token.accounted', (e) => {
    hostEvents.emit('subagent.token_accounted', {
      sessionId: hostSessionId,
      subagentId: subagentId(),
      agentName: agentName(),
      provider: e.provider ?? subagentProvider,
      model: e.model ?? subagentModel,
      // The subagent counter's own running total, not the leader's.
      usage: tokenCounter ? tokenCounter.total() : e.usage,
      deltaUsage: e.deltaUsage,
      cost: e.cost,
    });
  });

  const bridgeAttempt = (
    outcome: 'started' | 'completed' | 'failed',
    e: {
      attempt?: number | undefined;
      providerId?: string | undefined;
      model?: string | undefined;
      durationMs?: number | undefined;
      stopReason?: string | undefined;
      usage?: Usage | undefined;
      description?: string | undefined;
      status?: number | undefined;
      failureKind?: string | undefined;
      retryable?: boolean | undefined;
      traceId?: string | undefined;
      logicalRequestId?: string | undefined;
      promptManifestId?: string | undefined;
      attemptId?: string | undefined;
    },
  ): void => {
    hostEvents.emit('subagent.provider_attempt', {
      sessionId: hostSessionId,
      subagentId: subagentId(),
      agentName: agentName(),
      outcome,
      provider: e.providerId ?? subagentProvider,
      model: e.model ?? subagentModel,
      attempt: e.attempt,
      durationMs: e.durationMs,
      stopReason: e.stopReason,
      usage: e.usage,
      description: e.description,
      status: e.status,
      failureKind: e.failureKind,
      retryable: e.retryable,
      traceId: e.traceId,
      logicalRequestId: e.logicalRequestId,
      promptManifestId: e.promptManifestId,
      attemptId: e.attemptId,
    });
  };
  const offAttemptStarted = events.on('provider.attempt.started', (e) =>
    bridgeAttempt('started', e),
  );
  const offAttemptCompleted = events.on('provider.attempt.completed', (e) =>
    bridgeAttempt('completed', e),
  );
  const offAttemptFailed = events.on('provider.attempt.failed', (e) => bridgeAttempt('failed', e));

  return () => {
    offToolStartedBridge();
    offToolProgressBridge();
    offToolBridge();
    offSummaryBridge();
    offCtxBridge();
    offTokenBridge();
    offAttemptStarted();
    offAttemptCompleted();
    offAttemptFailed();
  };
}
