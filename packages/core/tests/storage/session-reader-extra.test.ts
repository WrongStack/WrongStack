import { describe, expect, it } from 'vitest';
import { DefaultSessionReader } from '../../src/storage/session-reader.js';
import type { SessionEvent } from '../../src/types/session.js';

// Covers the across-all-sessions search filters, the search limit cutoff, the
// export include-flag branches, the invalid-regex throw, and the eventText /
// contentToString branches for event/content-block types the main suite skips.

const ts = '2026-01-01T00:00:00.000Z';

interface FakeSummary {
  id: string;
  title: string;
  startedAt: string;
  provider: string;
  model: string;
  tokenTotal: number;
}

function makeReader(summaries: FakeSummary[], eventsById: Record<string, SessionEvent[]>) {
  const store = {
    list: async () => summaries,
    load: async (id: string) => ({
      metadata: { id, startedAt: ts, model: 'm', provider: 'p' },
      events: eventsById[id] ?? [],
      messages: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolCallEnds: [],
    }),
  };
  return new DefaultSessionReader({ store: store as never });
}

describe('session-reader — extra coverage', () => {
  it('applies sessionQuery filters when searching across all sessions', async () => {
    const summaries: FakeSummary[] = [
      { id: 'keep', title: 'Keep me', startedAt: '2026-02-01T00:00:00Z', provider: 'anthropic', model: 'opus', tokenTotal: 500 },
      { id: 'old', title: 'old', startedAt: '2025-01-01T00:00:00Z', provider: 'anthropic', model: 'opus', tokenTotal: 500 },
      { id: 'future', title: 'future', startedAt: '2027-01-01T00:00:00Z', provider: 'anthropic', model: 'opus', tokenTotal: 500 },
      { id: 'wrongprov', title: 'wrongprov', startedAt: '2026-02-01T00:00:00Z', provider: 'openai', model: 'opus', tokenTotal: 500 },
      { id: 'wrongmodel', title: 'wrongmodel', startedAt: '2026-02-01T00:00:00Z', provider: 'anthropic', model: 'planner', tokenTotal: 500 },
      { id: 'lowtok', title: 'lowtok', startedAt: '2026-02-01T00:00:00Z', provider: 'anthropic', model: 'opus', tokenTotal: 1 },
      { id: 'wrongtitle', title: 'nope', startedAt: '2026-02-01T00:00:00Z', provider: 'anthropic', model: 'opus', tokenTotal: 500 },
    ];
    const ev = (): SessionEvent[] => [{ type: 'user_input', ts, content: 'needle here' } as SessionEvent];
    const eventsById = Object.fromEntries(summaries.map((s) => [s.id, ev()]));
    const reader = makeReader(summaries, eventsById);
    const hits = await reader.search(
      { query: 'needle' },
      undefined,
      { since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z', provider: 'anthropic', model: 'opus', minTokens: 100, titleContains: 'keep' },
    );
    expect(hits.map((h) => h.sessionId)).toEqual(['keep']);
  });

  it('stops collecting hits once the limit is reached', async () => {
    const events: SessionEvent[] = Array.from({ length: 10 }, () => ({ type: 'user_input', ts, content: 'match' }) as SessionEvent);
    const reader = makeReader(
      [{ id: 's', title: 't', startedAt: ts, provider: 'p', model: 'm', tokenTotal: 0 }],
      { s: events },
    );
    const hits = await reader.search({ query: 'match', limit: 3 }, 's');
    expect(hits).toHaveLength(3);
  });

  it('throws on an invalid search regex', async () => {
    const reader = makeReader([{ id: 's', title: 't', startedAt: ts, provider: 'p', model: 'm', tokenTotal: 0 }], { s: [] });
    await expect(reader.search({ query: '(unclosed', regex: true }, 's')).rejects.toThrow(/Invalid search regex/);
  });

  it('export honors includeTools:false and includeDiagnostics:false', async () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts, content: 'hello' } as SessionEvent,
      { type: 'tool_use', ts, id: 'x', name: 'bash', input: { cmd: 'ls' } } as SessionEvent,
      { type: 'error', ts, phase: 'tool', message: 'boom' } as SessionEvent,
    ];
    const reader = makeReader([{ id: 's', title: 't', startedAt: ts, provider: 'p', model: 'm', tokenTotal: 0 }], { s: events });
    const md = await reader.export('s', { format: 'json', includeTools: false, includeDiagnostics: false });
    expect(md).not.toContain('bash');
    expect(md).not.toContain('boom');
    expect(md).toContain('hello');
  });

  it('extracts searchable text from every event and content-block type', async () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts, id: '1', name: 'grepNEEDLE', input: {} } as SessionEvent,
      { type: 'tool_result', ts, id: '1', content: 'resultNEEDLE' } as SessionEvent,
      { type: 'error', ts, phase: 'phaseNEEDLE', message: 'm' } as SessionEvent,
      { type: 'session_start', ts, id: 's', model: 'modelNEEDLE', provider: 'p' } as SessionEvent,
      { type: 'task_created', ts, taskId: 't', title: 'taskNEEDLE' } as SessionEvent,
      { type: 'task_failed', ts, taskId: 't', title: 'tf', error: 'failNEEDLE' } as SessionEvent,
      { type: 'skill_activated', ts, skillName: 'skillNEEDLE' } as SessionEvent,
      {
        type: 'llm_response',
        ts,
        content: [
          { type: 'text', text: 'textNEEDLE' },
          { type: 'tool_use', id: 'a', name: 'blockNEEDLE', input: {} },
          { type: 'tool_result', tool_use_id: 'a', content: 'tcNEEDLE' },
          { type: 'thinking', thinking: 'ignored block type' },
        ],
        usage: { input: 0, output: 0 },
      } as never as SessionEvent,
    ];
    const reader = makeReader([{ id: 's', title: 't', startedAt: ts, provider: 'p', model: 'm', tokenTotal: 0 }], { s: events });
    const hits = await reader.search({ query: 'NEEDLE', caseInsensitive: false, limit: 100 }, 's');
    expect(hits.length).toBeGreaterThanOrEqual(7);
  });
});
