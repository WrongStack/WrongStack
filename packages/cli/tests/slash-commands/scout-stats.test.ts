import type { SessionEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  buildScoutStatsCommand,
  formatVariantUsage,
  SOLO_HEAVY_TOOL_CALLS,
  summarizeVariantUsage,
} from '../../src/slash-commands/scout-stats.js';

const ts = '2026-10-04T00:00:00.000Z';
const input = (): SessionEvent => ({ type: 'user_input', ts, content: 'go' });
const request = (systemVariant?: string): SessionEvent => ({
  type: 'llm_request',
  ts,
  model: 'm',
  messageCount: 1,
  ...(systemVariant ? { systemVariant } : {}),
});
const response = (inputTokens: number, outputTokens: number): SessionEvent => ({
  type: 'llm_response',
  ts,
  content: [],
  stopReason: 'end_turn',
  usage: { input: inputTokens, output: outputTokens },
});
const call = (name: string, id: string, args: unknown = {}): SessionEvent => ({
  type: 'tool_call_start',
  ts,
  name,
  id,
  input: args,
});
const result = (id: string, content: string): SessionEvent => ({
  type: 'tool_result',
  ts,
  id,
  content,
  isError: false,
});

describe('summarizeVariantUsage', () => {
  it('measures discovery: empty searches and found-then-used calls', () => {
    const [scout] = summarizeVariantUsage([
      [
        input(),
        request('scout'),
        call('tool_search', 's1', { query: 'zip' }),
        result('s1', 'tool_search (total=0 truncated=false _available=70)\ntools:'),
        call('tool_search', 's2', { query: 'diff files' }),
        result(
          's2',
          'tool_search (total=1 truncated=false)\ntools:\n{"name":"diff","description":"x"}',
        ),
        call('tool_use', 'u1', { tool: 'diff', input: {} }),
        call('tool_use', 'u2', { tool: 'git', input: {} }),
        response(100, 20),
      ],
    ]);

    expect(scout).toMatchObject({
      variant: 'scout',
      sessions: 1,
      runs: 1,
      toolCalls: 4,
      lazyCalls: 2,
      searches: 2,
      emptySearches: 1,
      searchedThenUsed: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('splits runs at user input and separates delegating from solo-heavy runs', () => {
    const soloCalls = Array.from({ length: SOLO_HEAVY_TOOL_CALLS }, (_, i) =>
      call('read', `r${i}`),
    );
    const [scout] = summarizeVariantUsage([
      [
        input(),
        request('scout'),
        call('delegate', 'd1', { task: 'x' }),
        input(),
        request('scout'),
        call('tool_use', 'u1', { tool: 'spawn_subagent', input: {} }),
        input(),
        request('scout'),
        ...soloCalls,
        input(),
        request('scout'),
        call('read', 'q1'),
      ],
    ]);

    expect(scout).toMatchObject({
      runs: 4,
      delegations: 2,
      runsWithDelegation: 2,
      soloHeavyRuns: 1,
    });
  });

  it('keeps variants apart and labels journals without a recorded variant', () => {
    const usage = summarizeVariantUsage([
      [input(), request('scout'), input(), request('scout')],
      [input(), request('default')],
      [input(), request()],
    ]);

    expect(usage.map((u) => [u.variant, u.sessions, u.runs])).toEqual([
      ['scout', 1, 2],
      ['default', 1, 1],
      ['unrecorded', 1, 1],
    ]);
    expect(formatVariantUsage(usage, 3)).toContain('unrecorded');
  });

  it('ignores runs with neither a request nor a tool call', () => {
    expect(summarizeVariantUsage([[input(), input()]])).toEqual([]);
  });
});

describe('formatVariantUsage', () => {
  it('lists Scout first and says when nothing was found', () => {
    const usage = summarizeVariantUsage([
      [input(), request('default'), input(), request('default')],
      [input(), request('scout')],
    ]);
    const text = formatVariantUsage(usage, 2);
    expect(text.indexOf('scout')).toBeLessThan(text.indexOf('default'));
    expect(formatVariantUsage([], 5)).toBe('No runs found in the last 5 session(s).');
  });
});

describe('/scout-stats', () => {
  it('reads the requested number of journals and reports unreadable ones', async () => {
    const loaded: string[] = [];
    const store = {
      list: async (limit: number) => [{ id: 'a' }, { id: 'b' }].slice(0, limit),
      load: async (id: string) => {
        loaded.push(id);
        if (id === 'b') throw new Error('corrupt');
        return { events: [input(), request('scout')] };
      },
    };
    const command = buildScoutStatsCommand({ sessionStore: store } as never);

    const out = (await command.run('2')) ?? {};

    expect(loaded).toEqual(['a', 'b']);
    expect(out.message).toContain('scout');
    expect(out.message).toContain('1 session(s) could not be read.');
  });

  it('explains when no session store is wired', async () => {
    const out = (await buildScoutStatsCommand({} as never).run('')) ?? {};
    expect(out.message).toBe('Session store not available in this context.');
  });
});
