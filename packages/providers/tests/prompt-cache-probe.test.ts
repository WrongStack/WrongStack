import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import {
  diffCacheProbe,
  fingerprintCacheProbe,
  isCacheProbeEnabled,
  resetCacheProbeState,
} from '../src/prompt-cache-probe.js';

const seg = (instructions: string, tools: unknown[], items: unknown[]) =>
  fingerprintCacheProbe({ instructions, tools, items });

afterEach(() => {
  delete process.env['WRONGSTACK_CACHE_PROBE'];
  resetCacheProbeState();
});

describe('diffCacheProbe', () => {
  it('reports append-only growth as a fully reusable prefix', () => {
    const prev = seg('sys', [{ name: 'read' }], [{ a: 1 }, { b: 2 }]);
    const cur = seg('sys', [{ name: 'read' }], [{ a: 1 }, { b: 2 }, { c: 3 }]);
    const diff = diffCacheProbe(prev, cur);
    expect(diff.firstDivergentItem).toBeNull();
    expect(diff.instructionsChanged).toBe(false);
    // Everything except the newly appended item is reusable.
    expect(diff.promptChars - diff.cacheablePrefixChars).toBe(JSON.stringify({ c: 3 }).length);
  });

  it('names the first item that changed and voids everything behind it', () => {
    const prev = seg('sys', [], [{ a: 1 }, { b: 2 }, { c: 3 }]);
    const cur = seg('sys', [], [{ a: 1 }, { b: 'CHANGED' }, { c: 3 }]);
    const diff = diffCacheProbe(prev, cur);
    expect(diff.firstDivergentItem).toBe(1);
    expect(diff.cacheablePrefixChars).toBe(
      'sys'.length + JSON.stringify([]).length + JSON.stringify({ a: 1 }).length,
    );
  });

  it('voids the whole prefix when instructions change', () => {
    const prev = seg('sys A', [{ name: 'read' }], [{ a: 1 }]);
    const cur = seg('sys B', [{ name: 'read' }], [{ a: 1 }]);
    const diff = diffCacheProbe(prev, cur);
    expect(diff.instructionsChanged).toBe(true);
    expect(diff.cacheablePrefixChars).toBe(0);
  });

  it('keeps only instructions when the tool list changes', () => {
    const prev = seg('sys', [{ name: 'read' }], [{ a: 1 }]);
    const cur = seg('sys', [{ name: 'read' }, { name: 'write' }], [{ a: 1 }]);
    const diff = diffCacheProbe(prev, cur);
    expect(diff.toolsChanged).toBe(true);
    expect(diff.cacheablePrefixChars).toBe('sys'.length);
  });

  it('treats the first request of a session as an unavoidable miss', () => {
    const diff = diffCacheProbe(undefined, seg('sys', [], [{ a: 1 }]));
    expect(diff.cacheablePrefixChars).toBe(0);
  });
});

describe('probe gate', () => {
  it('is off unless the env var is set', () => {
    resetCacheProbeState();
    expect(isCacheProbeEnabled()).toBe(false);
  });

  it('writes one line per request when switched on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-probe-'));
    const file = path.join(dir, 'probe.jsonl');
    process.env['WRONGSTACK_CACHE_PROBE'] = file;
    resetCacheProbeState();

    const bodies: string[] = [];
    const sse =
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n' +
      'data: [DONE]\n\n';
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        bodies.push(init.body ?? '');
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '',
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse));
              c.close();
            },
          }),
        };
      }) as unknown as typeof fetch,
    });

    const req = (text: string) => ({
      model: 'gpt-5.4',
      system: [{ type: 'text' as const, text: 'stable system prompt' }],
      messages: [{ role: 'user' as const, content: text }],
      cache: { sessionId: 'sess-probe' },
    });
    const signal = new AbortController().signal;
    for (const text of ['first', 'second']) {
      for await (const _ev of provider.stream(req(text) as never, { signal })) {
        /* drain */
      }
    }

    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['kind'])).toEqual(['req', 'usage', 'req', 'usage']);
    expect(lines[0]?.['first']).toBe(true);
    expect(lines[2]?.['session']).toBe('sess-probe');
    expect(lines[2]?.['instructionsChanged']).toBe(false);
    // The backend's own number rides alongside, so an expected-vs-actual gap
    // separates a broken prefix from an expired cache entry.
    expect(lines[3]?.['cachedTokens']).toBe(80);
    expect(lines[3]?.['actualHitPct']).toBe(80);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
