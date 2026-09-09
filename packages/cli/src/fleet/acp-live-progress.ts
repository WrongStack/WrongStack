/**
 * Bridge ACP session/update progress onto the same buses in-process
 * subagents use, so TUI fleet chat, WebUI Agents panel, and HQ timeline
 * can watch Claude Code / Gemini / Kimi the same way they watch a native worker.
 */
import type { ACPProgressEvent } from '@wrongstack/acp';
import type { FleetBus } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { compactBridgeToolInput } from './host-event-bridge.js';

export interface PublishAcpLiveProgressOpts {
  event: ACPProgressEvent;
  subagentId: string;
  agentName: string;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  fleet?: Pick<FleetBus, 'emit'> | undefined;
  hostEvents?: Pick<EventBus, 'emit'> | undefined;
}

function toolName(title: string | undefined, kind: string | undefined): string {
  const t = title?.trim();
  if (t) return t;
  return kind && kind.length > 0 ? kind : 'tool';
}

export function publishAcpLiveProgress(opts: PublishAcpLiveProgressOpts): void {
  const { event, subagentId, agentName, sessionId, taskId, fleet, hostEvents } = opts;
  const ts = Date.now();

  switch (event.type) {
    case 'message': {
      if (!event.text) return;
      fleet?.emit({
        subagentId,
        taskId,
        ts,
        type: 'provider.text_delta',
        payload: { text: event.text },
      });
      return;
    }
    case 'thought': {
      if (!event.text) return;
      fleet?.emit({
        subagentId,
        taskId,
        ts,
        type: 'provider.thinking_delta',
        payload: { text: event.text },
      });
      return;
    }
    case 'tool_call': {
      const name = toolName(event.toolCall.title, event.toolCall.kind);
      const id = event.toolCall.toolCallId;
      const input = compactBridgeToolInput(event.toolCall.rawInput);
      fleet?.emit({
        subagentId,
        taskId,
        ts,
        type: 'tool.started',
        payload: { id, name, input },
      });
      hostEvents?.emit('subagent.tool_started', {
        sessionId,
        subagentId,
        agentName,
        taskId,
        id,
        name,
        input,
      });
      return;
    }
    case 'tool_call_update': {
      const status = event.toolCall.status;
      if (status !== 'completed' && status !== 'failed') return;
      const name = toolName(event.toolCall.title, event.toolCall.kind);
      const id = event.toolCall.toolCallId;
      const ok = status === 'completed';
      const output =
        event.toolCall.rawOutput !== undefined
          ? safeJson(event.toolCall.rawOutput)
          : undefined;
      fleet?.emit({
        subagentId,
        taskId,
        ts,
        type: 'tool.executed',
        payload: { id, name, ok, output, durationMs: 0 },
      });
      hostEvents?.emit('subagent.tool_executed', {
        sessionId,
        subagentId,
        agentName,
        taskId,
        id,
        name,
        ok,
        durationMs: 0,
        output,
      });
      return;
    }
    case 'diff': {
      const filePath = event.diff.path;
      if (!filePath) return;
      hostEvents?.emit('file.activity', {
        filePath,
        operation: event.diff.oldText === null ? 'write' : 'edit',
        phase: 'changed',
        source: 'deterministic',
        at: ts,
        sessionId,
        agentId: subagentId,
        agentName,
      });
      return;
    }
    default:
      return;
  }
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text.length > 4_096 ? `${text.slice(0, 4_095)}…` : text;
  } catch {
    return undefined;
  }
}
