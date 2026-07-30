import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSessionReader } from '../../src/storage/session-reader.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

async function mkdtemp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sessions-'));
}

async function seedSession(
  dir: string,
  id: string,
  opts: {
    model: string;
    provider: string;
    startedAt: string;
    title: string;
    body?: string;
    tokens?: { input: number; output: number };
  },
): Promise<void> {
  const tokens = opts.tokens ?? { input: 100, output: 50 };
  const file = path.join(dir, `${id}.jsonl`);
  const events = [
    {
      type: 'session_start',
      ts: opts.startedAt,
      id,
      model: opts.model,
      provider: opts.provider,
    },
    {
      type: 'user_input',
      ts: opts.startedAt,
      content: opts.title,
    },
    {
      type: 'llm_response',
      ts: opts.startedAt,
      content: [{ type: 'text', text: opts.body ?? 'reply' }],
      stopReason: 'end_turn',
      usage: { input: tokens.input, output: tokens.output },
    },
    {
      type: 'session_end',
      ts: opts.startedAt,
      usage: { input: tokens.input, output: tokens.output, cacheRead: 0, cacheWrite: 0 },
    },
  ];
  await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
}

describe('DefaultSessionReader (L2-A)', () => {
  let dir: string;
  let store: DefaultSessionStore;
  let reader: DefaultSessionReader;

  beforeEach(async () => {
    dir = await mkdtemp();
    store = new DefaultSessionStore({ dir });
    reader = new DefaultSessionReader({ store });
  });

  it('query returns every session when called with no filters', async () => {
    await seedSession(dir, 'a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-04-01T10:00:00.000Z',
      title: 'fix the bug',
    });
    await seedSession(dir, 'b', {
      model: 'claude',
      provider: 'anthropic',
      startedAt: '2026-04-02T10:00:00.000Z',
      title: 'write tests',
    });
    const results = await reader.query();
    expect(results.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('query filters by provider, model, and time range', async () => {
    await seedSession(dir, 'a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'old',
    });
    await seedSession(dir, 'b', {
      model: 'claude',
      provider: 'anthropic',
      startedAt: '2026-04-01T00:00:00.000Z',
      title: 'recent',
    });
    await seedSession(dir, 'c', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-05-01T00:00:00.000Z',
      title: 'newest',
    });

    const byProvider = await reader.query({ provider: 'openai' });
    expect(byProvider.map((r) => r.id).sort()).toEqual(['a', 'c']);

    const byModel = await reader.query({ model: 'claude' });
    expect(byModel.map((r) => r.id)).toEqual(['b']);

    const byRange = await reader.query({
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-04-30T00:00:00.000Z',
    });
    expect(byRange.map((r) => r.id)).toEqual(['b']);
  });

  it('query filters by title substring (case-insensitive) and minTokens', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'Fix Bug',
      tokens: { input: 10, output: 5 },
    });
    await seedSession(dir, 'b', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-02T00:00:00.000Z',
      title: 'add feature',
      tokens: { input: 1000, output: 500 },
    });
    const byTitle = await reader.query({ titleContains: 'BUG' });
    expect(byTitle.map((r) => r.id)).toEqual(['a']);
    const byTokens = await reader.query({ minTokens: 100 });
    expect(byTokens.map((r) => r.id)).toEqual(['b']);
  });

  it('replay yields events in chronological order', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'hi',
    });
    const events = [];
    for await (const e of reader.replay('a')) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'session_start',
      'user_input',
      'llm_response',
      'session_end',
    ]);
  });

  it('search finds literal substring matches across sessions', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'how do I configure tsup',
    });
    await seedSession(dir, 'b', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-02T00:00:00.000Z',
      title: 'unrelated topic',
    });
    const hits = await reader.search({ query: 'tsup' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('a');
    expect(hits[0]!.snippet).toContain('tsup');
  });

  it('search supports regex mode and respects case-insensitive default', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'Error code 42 happened',
    });
    const re = await reader.search({ query: 'error\\s+code\\s+\\d+', regex: true });
    expect(re).toHaveLength(1);
    const cs = await reader.search({ query: 'ERROR', regex: false, caseInsensitive: false });
    expect(cs).toHaveLength(0);
  });

  it('search limits to specified event types', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'reply text',
      body: 'reply text',
    });
    const userOnly = await reader.search({ query: 'reply', types: ['user_input'] });
    expect(userOnly).toHaveLength(1);
    expect(userOnly[0]!.type).toBe('user_input');
  });

  it('search can be scoped to a single session', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'foo',
    });
    await seedSession(dir, 'b', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-02T00:00:00.000Z',
      title: 'foo',
    });
    const hits = await reader.search({ query: 'foo' }, 'b');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('b');
  });

  it('delegates replay/metadata/export to the bounded store-level cache', async () => {
    await seedSession(dir, 'cache-me', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'cached title',
      body: 'cached body',
    });

    const loadSpy = vi.spyOn(store, 'load');

    const replayed = [];
    for await (const event of reader.replay('cache-me')) replayed.push(event.type);
    expect(replayed).toContain('session_end');
    await reader.metadata('cache-me');
    await reader.export('cache-me', { format: 'text' });

    // The reader deliberately owns no second SessionData cache: each public
    // operation delegates to DefaultSessionStore, whose single bounded cache
    // retains one entry and serves the repeated reads.
    expect(loadSpy).toHaveBeenCalledTimes(3);
    const storeCache = (store as unknown as { _loadCache: Map<string, unknown> })._loadCache;
    expect(storeCache.size).toBe(1);
    expect(storeCache.has('cache-me')).toBe(true);
  });

  it('export markdown renders user/assistant turns', async () => {
    await seedSession(dir, 'a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'hello world',
      body: 'hi there',
    });
    const md = await reader.export('a', { format: 'markdown' });
    expect(md).toContain('# Session a');
    expect(md).toContain('## User');
    expect(md).toContain('hello world');
    expect(md).toContain('## Assistant');
    expect(md).toContain('hi there');
  });

  it('export json round-trips events and metadata', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'q',
    });
    const json = await reader.export('a', { format: 'json' });
    const parsed = JSON.parse(json);
    expect(parsed.metadata.id).toBe('a');
    expect(parsed.events.length).toBeGreaterThan(0);
  });

  it('export text format includes timestamps and role markers', async () => {
    await seedSession(dir, 'a', {
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'q',
    });
    const text = await reader.export('a', { format: 'text' });
    expect(text).toContain('Session a');
    expect(text).toContain('USER');
    expect(text).toContain('ASSISTANT');
  });

  it('markdown export renders tool_use / tool_result / error / compaction blocks', async () => {
    const file = path.join(dir, 'rich.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        id: 'rich',
        model: 'm',
        provider: 'p',
      },
      { type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'do it' },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:02.000Z',
        content: [{ type: 'text', text: 'sure' }],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
      },
      {
        type: 'tool_use',
        ts: '2026-01-01T00:00:03.000Z',
        id: 'tu1',
        name: 'bash',
        input: { command: 'ls' },
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:04.000Z',
        id: 'tu1',
        content: 'file.txt',
        isError: false,
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:05.000Z',
        id: 'tu2',
        content: 'oops',
        isError: true,
      },
      { type: 'error', ts: '2026-01-01T00:00:06.000Z', phase: 'tool', message: 'kapow' },
      { type: 'compaction', ts: '2026-01-01T00:00:07.000Z', before: 1000, after: 500 },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const md = await reader.export('rich', { format: 'markdown' });
    expect(md).toContain('### Tool call: `bash`');
    expect(md).toContain('### Tool result');
    expect(md).toContain('### Tool result (error)');
    expect(md).toContain('**Error**');
    expect(md).toContain('kapow');
    expect(md).toContain('**Compaction**');
    expect(md).toContain('1000 → 500');
  });

  it('text export renders tool_use / tool_result / error blocks', async () => {
    const file = path.join(dir, 'rich2.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        id: 'rich2',
        model: 'm',
        provider: 'p',
      },
      {
        type: 'tool_use',
        ts: '2026-01-01T00:00:03.000Z',
        id: 'tu1',
        name: 'bash',
        input: { command: 'ls' },
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:04.000Z',
        id: 'tu1',
        content: 'file.txt',
        isError: false,
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:05.000Z',
        id: 'tu2',
        content: 'fail',
        isError: true,
      },
      { type: 'error', ts: '2026-01-01T00:00:06.000Z', phase: 'tool', message: 'kapow' },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const text = await reader.export('rich2', { format: 'text' });
    expect(text).toContain('TOOL_USE bash');
    expect(text).toContain('TOOL_RESULT');
    expect(text).toContain('TOOL_RESULT (error)');
    expect(text).toContain('ERROR (tool)');
  });

  it('export renders stop reason hint when non-end_turn', async () => {
    const file = path.join(dir, 'stoppy.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        id: 'stoppy',
        model: 'm',
        provider: 'p',
      },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:02.000Z',
        content: [{ type: 'text', text: 'truncated' }],
        stopReason: 'max_tokens',
        usage: { input: 1, output: 1 },
      },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const md = await reader.export('stoppy', { format: 'markdown' });
    expect(md).toContain('*stop: max_tokens*');
  });

  it('metadata returns session header without errors', async () => {
    await seedSession(dir, 'a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'q',
    });
    const meta = await reader.metadata('a');
    expect(meta.id).toBe('a');
    expect(meta.provider).toBe('openai');
    expect(meta.model).toBe('gpt-4');
  });

  it('search filters by sessionId when provided', async () => {
    await seedSession(dir, 'sess-a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'project alpha',
    });
    await seedSession(dir, 'sess-b', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-02T00:00:00.000Z',
      title: 'project beta',
    });

    // Search all sessions for "alpha"
    const allHits = await reader.search({ query: 'alpha' });
    expect(allHits.some((h) => h.sessionId === 'sess-a')).toBe(true);

    // Search only sess-a for "beta" — beta is in sess-b, so filtered result should be empty
    const filteredHits = await reader.search({ query: 'beta' }, 'sess-a');
    expect(filteredHits.every((h) => h.sessionId === 'sess-a')).toBe(true);
    expect(filteredHits.some((h) => h.sessionId === 'sess-b')).toBe(false);
  });

  it('search returns empty when sessionId does not exist', async () => {
    await seedSession(dir, 'sess-a', {
      model: 'gpt-4',
      provider: 'openai',
      startedAt: '2026-01-01T00:00:00.000Z',
      title: 'hello world',
    });
    const hits = await reader.search({ query: 'world' }, 'nonexistent');
    expect(hits).toEqual([]);
  });
});
