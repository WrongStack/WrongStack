import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { RunTurn } from './protocol-contract.js';
import { toolNameToKind, toolTitle } from './server-agent-turn-content.js';
import { acpAssistantText } from './server-assistant-text.js';

const MAX_CHILDREN = 256;

export function observeChildSessions(
  events: EventBus,
  owns: (sessionId: unknown) => boolean,
  publish: Parameters<RunTurn>[1],
) {
  const children = new Map<string, { id: string; active: boolean; tools: Set<string> }>();
  const publishChild = (id: string, title: string, description?: string) => {
    let child = children.get(id);
    if (!child) {
      if (children.size >= MAX_CHILDREN) return undefined;
      child = { id: `child_${randomUUID()}`, active: true, tools: new Set() };
      children.set(id, child);
    }
    if (!child.active) child.tools.clear();
    child.active = true;
    publish({
      sessionUpdate: 'subagent_update',
      sessionId: child.id,
      title,
      ...(description ? { description: description.slice(0, 1_000) } : {}),
      state: { state: 'running' },
    });
    return child;
  };
  const finish = (id: string, text: string | undefined, cancelled: boolean) => {
    const child = children.get(id);
    if (!child?.active) return;
    child.active = false;
    if (text) {
      publish(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: acpAssistantText(text) },
        },
        child.id,
      );
    }
    publish({
      sessionUpdate: 'subagent_update',
      sessionId: child.id,
      state: { state: 'idle', stopReason: cancelled ? 'cancelled' : 'end_turn' },
    });
  };
  const off = [
    events.on('acp.worker_update', (event) => {
      if (!owns(event.sessionId)) return;
      const id = `worker:${event.workerId}`;
      if (event.state === 'running') publishChild(id, event.agentId, event.task);
      else finish(id, event.text, false);
    }),
    events.on('delegate.started', (event) => {
      if (!owns(event.sessionId)) return;
      const id = event.subagentId ?? event.delegationId;
      if (id) publishChild(id, event.target, event.task);
    }),
    events.on('delegate.completed', (event) => {
      if (!owns(event.sessionId)) return;
      const id = event.subagentId ?? event.delegationId;
      if (id)
        finish(
          id,
          event.resultExcerpt || event.summary,
          event.stopReason === 'aborted' || event.status === 'stopped',
        );
    }),
    events.on('subagent.tool_started', (event) => {
      if (!owns(event.sessionId)) return;
      const child =
        children.get(event.subagentId) ??
        publishChild(event.subagentId, event.agentName ?? 'Subagent');
      if (!child?.active) return;
      child.tools.add(event.id);
      publish(
        {
          sessionUpdate: 'tool_call',
          toolCallId: event.id,
          title: toolTitle(event.name, event.input),
          kind: toolNameToKind(event.name),
          status: 'in_progress',
        },
        child.id,
      );
    }),
    events.on('subagent.tool_executed', (event) => {
      if (!event.id || !owns(event.sessionId)) return;
      const child = children.get(event.subagentId);
      if (!child?.active || !child.tools.has(event.id)) return;
      publish(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.id,
          status: event.ok ? 'completed' : 'failed',
        },
        child.id,
      );
      child.tools.delete(event.id);
    }),
    events.on('subagent.task_started', (event) => {
      if (owns(event.sessionId) && !children.get(event.subagentId)?.active) {
        publishChild(event.subagentId, 'Subagent', event.description);
      }
    }),
    events.on('subagent.task_completed', (event) => {
      if (owns(event.sessionId))
        finish(
          event.subagentId,
          event.finalText ?? event.error?.message,
          event.status === 'stopped',
        );
    }),
    events.on('subagent.removed', (event) => {
      if (owns(event.sessionId)) finish(event.subagentId, undefined, true);
    }),
  ];
  return () => {
    for (const unsub of off) unsub();
  };
}
