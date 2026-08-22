import { describe, expect, it } from 'vitest';
import { extractInterruptedTools, SessionRecovery } from '../../src/storage/session-recovery.js';
import type { SessionEvent } from '../../src/types/session.js';

const ev = (
  partial: Record<string, unknown>,
  ts = '2026-08-21T00:00:00.000Z',
): SessionEvent => ({ ts, ...partial }) as SessionEvent;

describe('SessionRecovery.buildRecoveryPlan', () => {
  it('flags stale when newest boundary is a dangling in_flight_start', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [ev({ type: 'user_input' }), ev({ type: 'in_flight_start', context: 'writing a.ts' })],
      'sess_a',
    );
    expect(plan.stale).toBe(true);
    expect(plan.sessionId).toBe('sess_a');
    expect(plan.context).toBe('writing a.ts');
  });

  it('is clean when session_end closes the run', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'user_input' }),
        ev({ type: 'session_end', usage: { input: 0, output: 0 } }),
      ],
      'sess_a',
    );
    expect(plan.stale).toBe(false);
    expect(plan.inFlightStart).toBeNull();
  });

  it('evicts oldest post-checkpoint events beyond MAX_PENDING_EVENTS', () => {
    const events: SessionEvent[] = [ev({ type: 'checkpoint' })];
    for (let i = 0; i < 10_002; i++) {
      events.push(ev({ type: 'tool_call_start', name: 'read', id: `t${i}` }));
    }
    const plan = SessionRecovery.buildRecoveryPlan(events, 'sess_b');
    // Same budget contract as recover(): tail capped at 10k events,
    // oldest-first eviction.
    expect(plan.pendingEvents.length).toBeLessThanOrEqual(10_000);
    const firstId = (plan.pendingEvents[0] as { id?: string }).id;
    expect(firstId).not.toBe('t0');
  });

  it('skips single oversized events instead of hanging the eviction loop', () => {
    // A serialized event larger than MAX_PENDING_BYTES must be skipped
    // outright — otherwise the while-loop can never satisfy its condition
    // and resume() would hang.
    const plan = SessionRecovery.buildRecoveryPlan(
      [ev({ type: 'tool_result', content: 'x'.repeat(17 * 1024 * 1024) })],
      'sess_c',
    );
    expect(plan.pendingEvents.length).toBe(0);
    expect(plan.stale).toBe(false);
  });
});

describe('extractInterruptedTools — id-less exclusion contract', () => {
  it('keeps rawId undefined for id-less llm_response tool_use blocks', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({
          type: 'llm_response',
          content: [{ type: 'tool_use', name: 'no_id_tool' }],
          usage: { input: 1, output: 1 },
        }),
      ],
      'sess_d',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    // executeResumeSession's synthesis gates on typeof tool.id === 'string';
    // undefined means it correctly skips pairing an error result that could
    // never match anything in the journal.
    expect(tools[0]?.id).toBeUndefined();
    expect(tools[0]?.name).toBe('no_id_tool');
  });

  it('preserves real ids so resume() can synthesize matching error results', () => {
    const plan = SessionRecovery.buildRecoveryPlan([
      ev({
        type: 'llm_response',
        content: [{ type: 'tool_use', id: 'tu-9', name: 'write_file' }],
        usage: { input: 1, output: 1 },
      }),
    ], 'sess_e');
    const tools = extractInterruptedTools(plan);
    expect(tools[0]?.id).toBe('tu-9');
  });
});

describe('SessionRecovery.buildRecoveryPlan — edge cases', () => {
  it('skips non-object events (null, numbers, strings, objects without type)', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'checkpoint' }),
        null as unknown as SessionEvent,
        42 as unknown as SessionEvent,
        'not-an-object' as unknown as SessionEvent,
        { hasNoType: true } as unknown as SessionEvent,
        ev({ type: 'user_input', content: 'after' }),
      ],
      'sess_x',
    );
    expect(plan.pendingEvents).toHaveLength(1);
    expect(plan.pendingEvents[0]!.type).toBe('user_input');
  });

  it('context is null when there is no dangling in_flight_start', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [ev({ type: 'user_input' }), ev({ type: 'session_end' })],
      'sess_y',
    );
    expect(plan.stale).toBe(false);
    expect(plan.inFlightStart).toBeNull();
    expect(plan.context).toBeNull();
  });
});

describe('extractInterruptedTools — edge cases', () => {
  it('uses the bare name as callId when tool_use has no id', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_call_start', name: 'bash' }),
      ],
      'sess_1',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBeUndefined();
    expect(tools[0]?.name).toBe('bash');
  });

  it('falls back to the name field when tool_result has no id or toolUseId', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', name: 'read_file' }),
        ev({ type: 'tool_result', name: 'read_file' } as never),
      ],
      'sess_2',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(0);
  });

  it('does nothing when tool_result has no resolvable callId', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', id: 'stays', name: 'read_file' }),
        ev({ type: 'tool_result' } as never),
      ],
      'sess_3',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');
  });

  it('does not enter any site for unrelated event types', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'user_input', content: 'hello' }),
        ev({ type: 'tool_use', id: 'keep', name: 'write' }),
      ],
      'sess_4',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
  });

  it('uses anonymous-seq callId for id-less tool_use blocks in message_appended', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({
          type: 'message_appended',
          ts: '2026-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'anon_tool', input: { x: 1 } }],
          },
        }),
      ],
      'sess_5',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('anon_tool');
  });

  it('falls back to the id field for message_appended tool_result without tool_use_id', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', id: 'call_w', name: 'read_file' }),
        ev({
          type: 'message_appended',
          ts: '2026-01-01T00:00:02Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', id: 'call_w' }],
          },
        }),
      ],
      'sess_6',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(0);
  });

  it('skips message_appended tool_result with no resolvable callId', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', id: 'survives', name: 'write' }),
        ev({
          type: 'message_appended',
          ts: '2026-01-01T00:00:02Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result' }],
          },
        }),
      ],
      'sess_7',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('write');
  });

  it('handles blocks that are neither tool_use nor tool_result in message_appended', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', id: 'keep2', name: 'bash' }),
        ev({
          type: 'message_appended',
          ts: '2026-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'thinking...' }],
          },
        }),
      ],
      'sess_8',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('bash');
  });

  it('does not summarize args when args is a non-object value', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', name: 'str_arg', id: 'c1', args: 'not an object' }),
      ],
      'sess_9',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.argsSummary).toBeUndefined();
  });

  it('skips message_appended events whose message.content is not an array', () => {
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', name: 'keep', id: 'c1' }),
        ev({
          type: 'message_appended',
          ts: '2026-01-01T00:00:02Z',
          message: { role: 'assistant', content: 'not-an-array' },
        }),
      ],
      'sess_mixed_msg',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('keep');
  });

  it('truncates very large args summaries after 80 chars', () => {
    const bigInput = { x: 'y'.repeat(200) };
    const plan = SessionRecovery.buildRecoveryPlan(
      [
        ev({ type: 'tool_use', name: 'big', id: 'c2', input: bigInput }),
      ],
      'sess_10',
    );
    const tools = extractInterruptedTools(plan);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.argsSummary).toContain('...');
    expect(tools[0]!.argsSummary!.length).toBeLessThan(81);
  });
});
