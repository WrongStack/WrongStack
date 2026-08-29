import type { SessionEvent, Message } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { replaySessionEvents, replaySessionMessages } from '../src/components/history/replay.js';

describe('replaySessionEvents — additional coverage', () => {
  describe('provider_retry', () => {
    it('renders with status code when present', () => {
      const events: SessionEvent[] = [{
        type: 'provider_retry', ts: '2026-01-01T00:00:00Z',
        attempt: 2, delayMs: 1500, status: 429, description: 'rate limited',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'warn' });
      expect((entries[0] as { text: string }).text).toContain('retry 2');
      expect((entries[0] as { text: string }).text).toContain('HTTP 429');
    });

    it('renders without status code', () => {
      const events: SessionEvent[] = [{
        type: 'provider_retry', ts: '2026-01-01T00:00:00Z',
        attempt: 1, delayMs: 500, status: undefined, description: 'timeout',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as { text: string }).text).not.toContain('HTTP');
      expect((entries[0] as { text: string }).text).toContain('retry 1');
    });
  });

  describe('provider_error', () => {
    it('renders with status and retryable', () => {
      const events: SessionEvent[] = [{
        type: 'provider_error', ts: '2026-01-01T00:00:00Z',
        description: 'server error', status: 503, retryable: true,
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'error' });
      const text = (entries[0] as { text: string }).text;
      expect(text).toContain('HTTP 503');
      expect(text).toContain('retryable');
    });

    it('renders without status and fatal', () => {
      const events: SessionEvent[] = [{
        type: 'provider_error', ts: '2026-01-01T00:00:00Z',
        description: 'auth failure', status: undefined, retryable: false,
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      const text = (entries[0] as { text: string }).text;
      expect(text).toContain('fatal');
      expect(text).not.toContain('HTTP');
    });
  });

  describe('checkpoint', () => {
    it('renders info entry with promptIndex and preview', () => {
      const events: SessionEvent[] = [{
        type: 'checkpoint', ts: '2026-01-01T00:00:00Z',
        promptIndex: 5, promptPreview: 'Implement feature X',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'info' });
      expect((entries[0] as { text: string }).text).toContain('#5');
      expect((entries[0] as { text: string }).text).toContain('Implement feature X');
    });
  });

  describe('mode_changed', () => {
    it('renders mode from → to', () => {
      const events: SessionEvent[] = [{
        type: 'mode_changed', ts: '2026-01-01T00:00:00Z',
        from: 'default', to: 'code',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'info' });
      expect((entries[0] as { text: string }).text).toContain('default → code');
    });
  });

  describe('skill_activated / skill_deactivated', () => {
    it('renders skill activated info entry', () => {
      const events: SessionEvent[] = [{
        type: 'skill_activated', ts: '2026-01-01T00:00:00Z',
        skillName: 'bug-hunter',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as { text: string }).text).toContain('bug-hunter');
    });

    it('renders skill deactivated info entry', () => {
      const events: SessionEvent[] = [{
        type: 'skill_deactivated', ts: '2026-01-01T00:00:00Z',
        skillName: 'security-scanner',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as { text: string }).text).toContain('security-scanner');
    });
  });

  describe('message_truncated', () => {
    it('renders warn with before → after when after < before', () => {
      const events: SessionEvent[] = [{
        type: 'message_truncated', ts: '2026-01-01T00:00:00Z',
        before: 5000, after: 2000,
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'warn' });
      expect((entries[0] as { text: string }).text).toContain('5000 → 2000');
    });

    it('renders truncated at when after >= before', () => {
      const events: SessionEvent[] = [{
        type: 'message_truncated', ts: '2026-01-01T00:00:00Z',
        before: 1000, after: 3000,
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      expect((entries[0] as { text: string }).text).toContain('truncated at 3000');
    });
  });

  describe('agent_stopped / agent_error', () => {
    it('does not render agent_stopped into resumed main history', () => {
      const events: SessionEvent[] = [{
        type: 'agent_stopped', ts: '2026-01-01T00:00:00Z',
        agentId: 'agent_abcdef12', role: 'bug-hunter',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toEqual([]);
    });

    it('does not render agent_error into resumed main history', () => {
      const longError = 'x'.repeat(200);
      const events: SessionEvent[] = [{
        type: 'agent_error', ts: '2026-01-01T00:00:00Z',
        agentId: 'agent_abcdef12', role: 'bug-hunter', error: longError,
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toEqual([]);
    });
  });

  describe('compaction with reductions and level', () => {
    it('includes level and reductions when present', () => {
      const events: SessionEvent[] = [{
        type: 'compaction', ts: '2026-01-01T00:00:00Z',
        before: 100000, after: 50000, level: 'hard',
        reductions: [{ phase: 'tool', saved: 25000 }, { phase: 'history', saved: 25000 }],
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(1);
      const text = (entries[0] as { text: string }).text;
      expect(text).toContain('(hard)');
      expect(text).toContain('100K → 50K');
      expect(text).toContain('tool: −25000');
    });
  });

  describe('user_input edge cases', () => {
    it('skips user_input with only whitespace', () => {
      const events: SessionEvent[] = [{
        type: 'user_input', ts: '2026-01-01T00:00:00Z', content: '   ',
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(0);
    });

    it('skips user_input with empty content array', () => {
      const events: SessionEvent[] = [{
        type: 'user_input', ts: '2026-01-01T00:00:00Z', content: [],
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(0);
    });
  });

  describe('llm_response with empty text', () => {
    it('skips llm_response where text content is only whitespace', () => {
      const events: SessionEvent[] = [{
        type: 'llm_response', ts: '2026-01-01T00:00:00Z',
        content: [{ type: 'text', text: '   ' }],
        stopReason: 'end_turn', usage: { input: 0, output: 0 },
      }] as never;
      const entries = replaySessionEvents(events, 1);
      expect(entries).toHaveLength(0);
    });
  });

  describe('skipped event types (internal)', () => {
    const internalTypes: SessionEvent['type'][] = [
      'session_start', 'session_resumed', 'session_end',
      'in_flight_start', 'in_flight_end', 'llm_request',
      'tool_progress', 'rewound', 'file_snapshot',
      'task_created', 'task_updated', 'task_completed', 'task_failed',
      'session_forked', 'side_effect',
    ];

    for (const type of internalTypes) {
      it(`skips ${type} events silently`, () => {
        const events: SessionEvent[] = [{ type, ts: '2026-01-01T00:00:00Z' } as SessionEvent] as never;
        const entries = replaySessionEvents(events, 1);
        expect(entries).toHaveLength(0);
      });
    }
  });

  describe('unknown event types', () => {
    it('skips unknown event types silently', () => {
      const events = [{ type: 'unknown_event_type', ts: '2026-01-01T00:00:00Z' }];
      const entries = replaySessionEvents(events as SessionEvent[], 1);
      expect(entries).toHaveLength(0);
    });
  });
});

describe('replaySessionMessages — additional coverage', () => {
  it('handles empty messages and empty events', () => {
    const entries = replaySessionMessages([], [], 1);
    expect(entries).toHaveLength(0);
  });

  it('handles messages with only empty content', () => {
    const messages: Message[] = [
      { role: 'user', content: '  ' },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    expect(entries).toHaveLength(0);
  });

  it('handles user messages with content blocks (non-string)', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello there' });
  });

  it('handles thinking block with only whitespace', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '   ' },
          { type: 'text', text: 'answer here' },
        ],
      },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    // Only the text part produces an assistant entry
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: 'answer here' });
  });

  it('handles tool_use blocks in messages enriched by tool_call_end', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
    ];
    const events: SessionEvent[] = [
      {
        type: 'tool_call_end', ts: '2026-01-01T00:00:01Z',
        name: 'read', id: 'tu-1', durationMs: 15, outputSize: 100, ok: true,
        outputBytes: 100, outputTokens: 25, outputLines: 5,
      },
    ] as never;
    const entries = replaySessionMessages(messages, events, 1);
    expect(entries).toHaveLength(2); // assistant + tool
    // `ok` comes from the tool_call_end record, exactly as the live bridge
    // takes it from `tool.executed`. This used to replay as `ok: false`
    // whenever the conversation held no tool_result block — a call the
    // journal explicitly recorded as successful came back marked failed.
    expect(entries[1]).toMatchObject({
      kind: 'tool', name: 'read', ok: true, durationMs: 15,
    });
  });

  it('captures tool_result blocks in messages with enrichment', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'tool result: ' },
          { type: 'tool_result', tool_use_id: 'tu-99', content: 'file content here', is_error: false },
        ],
      },
    ];
    const events: SessionEvent[] = [
      {
        type: 'tool_call_end', ts: '2026-01-01T00:00:00Z',
        name: 'read', id: 'tu-99', durationMs: 10, ok: true,
      },
    ] as never;
    const entries = replaySessionMessages(messages, events, 1);
    expect(entries).toHaveLength(2); // user + tool
    const toolEntry = entries[1]!;
    expect(toolEntry.kind).toBe('tool');
    expect((toolEntry as { output: string }).output).toContain('file content');
  });

  it('handles tool_result without matching tool_use or tool_call_end', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-orphan', content: 'orphan result', is_error: false },
        ],
      },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    expect(entries).toHaveLength(1);
    const toolEntry = entries[0]!;
    expect(toolEntry.kind).toBe('tool');
    expect((toolEntry as { name: string }).name).toBe('tu-orphan');
  });

  it('interleaves marker events by ts correctly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'reply', ts: '2026-01-01T00:00:05Z' },
    ];
    const events: SessionEvent[] = [
      { type: 'mode_changed', ts: '2026-01-01T00:00:02Z', from: 'default', to: 'code' },
    ] as never;
    const entries = replaySessionMessages(messages, events, 1);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'info', 'assistant']);
    expect((entries[1] as { text: string }).text).toContain('code');
  });

  it('handles system role messages as info entries', () => {
    const messages: Message[] = [
      { role: 'system', content: 'session initialized' },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'info', text: 'session initialized' });
  });
});
