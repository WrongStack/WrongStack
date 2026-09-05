import { contextPctFromLoad, nextId } from './viz-graph-helpers.js';
import { NODE_COLORS, type VizEvent } from './viz-types.js';

/**
 * Event pipeline helper: converts raw WS messages into VizEvents.
 * Called from ws-handlers to feed the AgentFlow visualization stream.
 */
export function wsToVizEvent(wsType: string, payload: Record<string, unknown>): VizEvent | null {
  switch (wsType) {
    case 'provider.text_delta': {
      const text = (payload.text as string) ?? '';
      return {
        id: nextId(),
        kind: 'provider:delta',
        timestamp: Date.now(),
        source: 'provider',
        target: 'leader',
        label: text.slice(0, 60),
        magnitude: text.length,
        data: { text },
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'provider.response': {
      const usage = payload.usage as
        | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
        | undefined;
      const total = (usage?.input ?? 0) + (usage?.output ?? 0);
      return {
        id: nextId(),
        kind: 'provider:response',
        timestamp: Date.now(),
        source: 'provider',
        target: 'leader',
        label: `${(usage?.input ?? 0).toLocaleString('en-US')} in / ${(usage?.output ?? 0).toLocaleString('en-US')} out`,
        magnitude: total,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'provider.stream_error': {
      const message = (payload.message as string) ?? 'Provider stream error';
      return {
        id: nextId(),
        kind: 'error',
        timestamp: Date.now(),
        source: 'provider',
        target: 'leader',
        label: message.slice(0, 80),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'provider',
      };
    }
    case 'tool.started': {
      const name = (payload.name as string) ?? 'tool';
      return {
        id: nextId(),
        kind: 'tool:started',
        timestamp: Date.now(),
        source: name,
        target: 'filesystem',
        label: name,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.executed': {
      const name = (payload.name as string) ?? 'tool';
      const ok = (payload.ok as boolean) ?? true;
      return {
        id: nextId(),
        kind: 'tool:executed',
        timestamp: Date.now(),
        source: name,
        target: 'leader',
        label: `${name} ${ok ? '✓' : '✗'} (${(payload.durationMs as number) ?? 0}ms)`,
        magnitude: (payload.durationMs as number) ?? 0,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.tool : NODE_COLORS.error,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.progress': {
      const name = (payload.name as string) ?? 'tool';
      const text = (payload.event as { type?: string; text?: string } | undefined)?.text ?? '';
      return {
        id: nextId(),
        kind: 'tool:progress',
        timestamp: Date.now(),
        source: name,
        target: 'leader',
        label: text.slice(0, 60) || name,
        magnitude: text.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'codemap.tool_started': {
      const name = (payload.name as string) ?? 'tool';
      const agentId = (payload.agentId as string) ?? 'subagent';
      return {
        id: nextId(),
        kind: 'tool:started',
        timestamp: Date.now(),
        source: agentId,
        target: name,
        label: name,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `agent:${agentId}`,
      };
    }
    case 'codemap.tool_executed': {
      const name = (payload.name as string) ?? 'tool';
      const agentId = (payload.agentId as string) ?? 'subagent';
      const ok = (payload.ok as boolean) ?? true;
      return {
        id: nextId(),
        kind: 'tool:executed',
        timestamp: Date.now(),
        source: agentId,
        target: name,
        label: `${name} ${ok ? '✓' : '✗'} (${(payload.durationMs as number) ?? 0}ms)`,
        magnitude: (payload.durationMs as number) ?? 0,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.tool : NODE_COLORS.error,
        flowGroup: `agent:${agentId}`,
      };
    }
    case 'tool.loop_detected': {
      const tools = (payload.tools as string) ?? '';
      const kind = (payload.kind as string) ?? 'loop';
      const isSteer = payload.action === 'steer';
      return {
        id: nextId(),
        kind: isSteer ? 'agent:status' : 'error',
        timestamp: Date.now(),
        source: tools || kind,
        target: 'leader',
        label: `${kind} loop x${(payload.repeatCount as number) ?? 0}`,
        magnitude: (payload.repeatCount as number) ?? 1,
        data: payload as Record<string, unknown>,
        color: isSteer ? NODE_COLORS.agent : NODE_COLORS.error,
        flowGroup: 'tool',
      };
    }
    case 'delegate.started': {
      const target = (payload.target as string) ?? 'delegate';
      const task = (payload.task as string) ?? '';
      return {
        id: nextId(),
        kind: 'agent:status',
        timestamp: Date.now(),
        source: 'leader',
        target,
        label: task.slice(0, 80) || `Delegating to ${target}`,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: `delegate:${target}`,
      };
    }
    case 'delegate.completed': {
      const target = (payload.subagentId as string) ?? (payload.target as string) ?? 'delegate';
      const ok = (payload.ok as boolean) ?? false;
      return {
        id: nextId(),
        kind: ok ? 'agent:status' : 'error',
        timestamp: Date.now(),
        source: target,
        target: 'leader',
        label: (
          (payload.summary as string) ??
          (payload.status as string) ??
          'delegate completed'
        ).slice(0, 80),
        magnitude: (payload.durationMs as number) ?? 1,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.agent : NODE_COLORS.error,
        flowGroup: `delegate:${target}`,
      };
    }
    case 'subagent.event': {
      const kind = payload.kind as string;
      const agentId = (payload.subagentId as string) ?? 'unknown';
      const agentName = (payload.name as string) ?? agentId;
      switch (kind) {
        case 'spawned':
          return {
            id: nextId(),
            kind: 'agent:spawned',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label: `${agentName} spawned`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'tool_executed': {
          const toolName = (payload.toolName as string) ?? 'tool';
          const toolOk = (payload.ok as boolean) ?? true;
          return {
            id: nextId(),
            kind: 'agent:tool',
            timestamp: Date.now(),
            source: agentId,
            target: toolName,
            label: toolName,
            magnitude: (payload.durationMs as number) ?? 0,
            data: payload as Record<string, unknown>,
            color: toolOk ? NODE_COLORS.tool : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'task_completed': {
          const status = (payload.status as string) ?? 'completed';
          return {
            id: nextId(),
            kind: 'agent:status',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label: `${agentName} ${status}`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: status === 'success' ? NODE_COLORS.success : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'ctx_pct':
          return {
            id: nextId(),
            kind: 'agent:ctx',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label: `ctx ${contextPctFromLoad(payload.load)}%`,
            magnitude: (payload.tokens as number) ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'iteration_summary':
          return {
            id: nextId(),
            kind: 'agent:text',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label:
              ((payload.partialText as string) ?? '').slice(0, 80) ||
              `iter ${(payload.iteration as number) ?? 0}`,
            magnitude: (payload.costUsd as number) ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'budget_extended':
          return {
            id: nextId(),
            kind: 'budget:extended',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label: `${agentName} extended budget`,
            magnitude: (payload.totalExtensions as number) ?? 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.tool,
            flowGroup: `agent:${agentId}`,
          };
        case 'budget_warning':
          return {
            id: nextId(),
            kind: 'budget:warning',
            timestamp: Date.now(),
            source: agentId,
            target: 'session',
            label: `${agentName} hit ${(payload.budgetKind as string) ?? 'budget'} ${(payload.used as number) ?? 0}/${(payload.limit as number) ?? 0}`,
            magnitude: (payload.used as number) ?? 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
      }
      return null;
    }
    case 'mailbox.event': {
      const eventName = payload.event as string;
      const from = (payload.from as string) ?? '?';
      const to = (payload.to as string) ?? '?';
      const subject = (payload.subject as string) ?? '';
      const isSend = eventName === 'mailbox.sent';
      return {
        id: nextId(),
        kind: isSend ? 'mailbox:send' : 'mailbox:deliver',
        timestamp: Date.now(),
        source: from,
        target: to,
        label: subject || (isSend ? `→ ${to}` : `← ${from}`),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.mailbox,
        flowGroup: 'mailbox',
      };
    }
    case 'iteration.started': {
      const idx = (payload.index as number) ?? 0;
      return {
        id: nextId(),
        kind: 'iteration:start',
        timestamp: Date.now(),
        source: 'leader',
        target: 'session',
        label: `Iteration ${idx}`,
        magnitude: idx,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: 'iteration',
      };
    }
    case 'iteration.completed': {
      const idx = (payload.index as number) ?? 0;
      return {
        id: nextId(),
        kind: 'iteration:end',
        timestamp: Date.now(),
        source: 'leader',
        target: 'session',
        label: `Iteration ${idx} done`,
        magnitude: idx,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.session,
        flowGroup: 'iteration',
      };
    }
    case 'ctx.pct': {
      const tokens = (payload.tokens as number) ?? 0;
      return {
        id: nextId(),
        kind: 'agent:ctx',
        timestamp: Date.now(),
        source: 'leader',
        target: 'session',
        label: `ctx ${contextPctFromLoad(payload.load)}%`,
        magnitude: tokens,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: 'leader',
      };
    }
    case 'error': {
      const msg = (payload.message as string) ?? 'Error';
      return {
        id: nextId(),
        kind: 'error',
        timestamp: Date.now(),
        source: (payload.phase as string) ?? 'system',
        target: 'session',
        label: msg,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'error',
      };
    }
    case 'context.compacted':
      return {
        id: nextId(),
        kind: 'context:compacted',
        timestamp: Date.now(),
        source: 'system',
        target: 'session',
        label: `Compacted: ${((payload.saved as number) ?? 0).toLocaleString('en-US')} tokens`,
        magnitude: (payload.saved as number) ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(var(--info))',
        flowGroup: 'context',
      };
    case 'compaction.failed': {
      const message = (payload.message as string) ?? 'Compaction failed';
      return {
        id: nextId(),
        kind: 'error',
        timestamp: Date.now(),
        source: 'compactor',
        target: 'session',
        label: message.slice(0, 80),
        magnitude: (payload.tokens as number) ?? 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'context',
      };
    }
    case 'context.repaired':
      return {
        id: nextId(),
        kind: 'context:repaired',
        timestamp: Date.now(),
        source: 'system',
        target: 'session',
        label: `Repaired: ${(payload.removedMessages as number) ?? 0} msgs`,
        magnitude: (payload.removedMessages as number) ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(var(--info))',
        flowGroup: 'context',
      };
    case 'session.start': {
      const sid = (payload.sessionId as string) ?? '?';
      const proj = (payload.projectName as string) ?? '';
      return {
        id: nextId(),
        kind: 'session:start',
        timestamp: Date.now(),
        source: 'session',
        target: 'leader',
        label: proj || sid.slice(0, 12),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.session,
        flowGroup: 'session',
      };
    }
    case 'sessions.status_update': {
      const sessions = (payload.sessions as Array<Record<string, unknown>>) ?? [];
      return {
        id: nextId(),
        kind: 'fleet:snapshot',
        timestamp: Date.now(),
        source: 'system',
        target: 'session',
        label: `${sessions.length} session(s)`,
        magnitude: sessions.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.system,
        flowGroup: 'fleet',
      };
    }
    default:
      return null;
  }
}
