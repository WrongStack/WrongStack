import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SubagentConfig } from '@wrongstack/core/types';

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
      input: e.input,
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
      input: e.input,
      output: e.output,
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
