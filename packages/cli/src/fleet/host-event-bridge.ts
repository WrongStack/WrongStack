import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SubagentConfig } from '@wrongstack/core/types';

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
}): () => void {
  const { events, hostEvents, hostSessionId, projectRoot, effectiveCfg, subCfg } = opts;
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

  return () => {
    offToolStartedBridge();
    offToolProgressBridge();
    offToolBridge();
    offSummaryBridge();
    offCtxBridge();
  };
}
