import { describe, expect, it } from 'vitest';
import { buildChatRows, type ChatRow } from '@/components/ChatView/utils';
import type { ChatMessage } from '@/stores';

let seq = 0;
function mk(role: ChatMessage['role'], over: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: over.id ?? `m${seq}`,
    role,
    content: over.content ?? `c${seq}`,
    timestamp: over.timestamp ?? 1_700_000_000_000,
    ...over,
  };
}

const DAY = 86_400_000;
// Fixed reference "now" so Today/Yesterday labels are deterministic.
const NOW = new Date('2026-06-13T12:00:00Z').getTime();

describe('buildChatRows', () => {
  it('returns no rows for an empty transcript', () => {
    expect(buildChatRows([], NOW)).toEqual([]);
  });

  it('groups consecutive tool messages into one agent turn with a tools item', () => {
    const msgs = [
      mk('user', { id: 'u1', timestamp: NOW }),
      mk('assistant', { id: 'a1', timestamp: NOW }),
      mk('tool', { id: 't1', timestamp: NOW, toolName: 'read', toolResult: 'ok' }),
      mk('tool', { id: 't2', timestamp: NOW, toolName: 'grep', toolResult: 'ok' }),
    ];
    const rows = buildChatRows(msgs, NOW);
    // day, user, agent
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(['day', 'user', 'agent']);
    const agent = rows[2] as Extract<ChatRow, { kind: 'agent' }>;
    expect(agent.items).toHaveLength(2); // assistant msg + one tools group
    const tools = agent.items[1];
    expect(tools?.kind).toBe('tools');
    if (tools?.kind === 'tools') {
      expect(tools.tools.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(tools.isContinuation).toBe(true);
      expect(tools.hasRunningTool).toBe(false);
      expect(tools.isLastGroup).toBe(true);
    }
  });

  it('marks hasRunningTool when a tool has no result yet', () => {
    const rows = buildChatRows(
      [
        mk('user', { timestamp: NOW }),
        mk('tool', { id: 'tr', timestamp: NOW, toolName: 'bash', toolResult: undefined }),
      ],
      NOW,
    );
    const agent = rows.find((r) => r.kind === 'agent') as Extract<ChatRow, { kind: 'agent' }>;
    expect(agent.isLastTurn).toBe(true);
    const tools = agent.items[0];
    expect(tools?.kind === 'tools' && tools.hasRunningTool).toBe(true);
  });

  it('starts a fresh user row for each user message and folds agent replies', () => {
    const rows = buildChatRows(
      [
        mk('user', { id: 'u1', timestamp: NOW }),
        mk('assistant', { id: 'a1', timestamp: NOW }),
        mk('user', { id: 'u2', timestamp: NOW }),
        mk('assistant', { id: 'a2', timestamp: NOW }),
      ],
      NOW,
    );
    const nonDay = rows.filter((r) => r.kind !== 'day');
    expect(nonDay.map((r) => r.kind)).toEqual(['user', 'agent', 'user', 'agent']);
    // last agent turn flagged
    const agents = nonDay.filter((r) => r.kind === 'agent') as Extract<
      ChatRow,
      { kind: 'agent' }
    >[];
    expect(agents[0]?.isLastTurn).toBe(false);
    expect(agents[1]?.isLastTurn).toBe(true);
  });

  it('emits a day separator only when the calendar day changes', () => {
    const rows = buildChatRows(
      [
        mk('user', { id: 'u1', timestamp: NOW - DAY }),
        mk('assistant', { id: 'a1', timestamp: NOW - DAY }),
        mk('user', { id: 'u2', timestamp: NOW }),
        mk('assistant', { id: 'a2', timestamp: NOW }),
      ],
      NOW,
    );
    const days = rows.filter((r) => r.kind === 'day') as Extract<ChatRow, { kind: 'day' }>[];
    expect(days).toHaveLength(2);
    expect(days[0]?.label).toBe('Yesterday');
    expect(days[1]?.label).toBe('Today');
  });

  it('tags continuation on same-role follow-ups within an agent turn', () => {
    const rows = buildChatRows(
      [
        mk('user', { timestamp: NOW }),
        mk('assistant', { id: 'a1', timestamp: NOW }),
        mk('assistant', { id: 'a2', timestamp: NOW }),
      ],
      NOW,
    );
    const agent = rows.find((r) => r.kind === 'agent') as Extract<ChatRow, { kind: 'agent' }>;
    expect(agent.items[0]?.kind === 'msg' && agent.items[0].isContinuation).toBe(false);
    expect(agent.items[1]?.kind === 'msg' && agent.items[1].isContinuation).toBe(true);
  });

  it('folds archived thinking logs into the current agent turn', () => {
    const rows = buildChatRows(
      [
        mk('user', { id: 'u1', timestamp: NOW }),
        mk('assistant', { id: 'a1', timestamp: NOW, content: 'answer' }),
        mk('system', {
          id: 'th1',
          timestamp: NOW,
          content: '',
          thinkingLog: {
            iteration: 1,
            text: 'reasoning trace',
            startedAt: NOW,
            durationMs: 500,
          },
        }),
      ],
      NOW,
    );

    const agent = rows.find((r) => r.kind === 'agent') as Extract<ChatRow, { kind: 'agent' }>;
    expect(agent.items).toHaveLength(2);
    expect(agent.items[1]?.kind === 'msg' && agent.items[1].message.thinkingLog?.text).toBe(
      'reasoning trace',
    );
    expect(agent.items[1]?.kind === 'msg' && agent.items[1].isContinuation).toBe(true);
  });
});
