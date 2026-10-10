/**
 * Every OpenAI-compatible endpoint's cache counts end up in the same disjoint
 * `Usage`: `input` fresh-only, `cacheRead` / `cacheWrite` separate. A count
 * left in `input` is billed at the full rate and hides the cache hit.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, StreamEvent } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeOpenAIChatUsage } from '../src/openai-chat-usage.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';

const START = { input: 0, output: 0 };

describe('normalizeOpenAIChatUsage', () => {
  it.each([
    [
      'OpenAI / xAI / z.ai',
      { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
      { input: 200, output: 50, cacheRead: 800 },
    ],
    [
      'OpenRouter cache writes',
      {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
      },
      { input: 100, output: 50, cacheRead: 600, cacheWrite: 300 },
    ],
    [
      'DeepSeek hit/miss',
      { prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300, completion_tokens: 10 },
      { input: 300, output: 10, cacheRead: 700 },
    ],
    [
      'Kimi top-level cached_tokens',
      { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 900 },
      { input: 100, output: 20, cacheRead: 900 },
    ],
    [
      'DashScope explicit cache write',
      {
        prompt_tokens: 2000,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 1497 },
      },
      { input: 503, output: 30, cacheWrite: 1497 },
    ],
    [
      'Anthropic-backed proxy (top-level Anthropic fields)',
      {
        prompt_tokens: 1500,
        completion_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 400,
      },
      { input: 100, output: 40, cacheRead: 1000, cacheWrite: 400 },
    ],
    [
      'MiniMax total-only',
      { total_tokens: 1200, completion_tokens: 200 },
      { input: 1000, output: 200 },
    ],
  ])('%s', (_name, wire, expected) => {
    const usage = normalizeOpenAIChatUsage(wire, START);
    expect({ ...usage, cacheRead: usage.cacheRead || undefined }).toEqual({
      cacheRead: undefined,
      ...expected,
    });
  });

  it('keeps earlier cache counts when a later chunk omits them', () => {
    const first = normalizeOpenAIChatUsage(
      { prompt_tokens: 1000, completion_tokens: 1, cached_tokens: 900 },
      START,
    );
    expect(normalizeOpenAIChatUsage({ completion_tokens: 80 }, first)).toMatchObject({
      output: 80,
      cacheRead: 900,
    });
  });

  // A provider may report usage on more than one chunk. When a later chunk
  // repeats `prompt_tokens` but omits the cache detail, `cacheRead` is still
  // retained from the earlier chunk — so `input` has to stay the fresh
  // remainder. Deducting only the current chunk's cache (zero) re-counted the
  // whole cached prefix as fresh, full-rate input and broke the disjointness
  // invariant this module exists to enforce.
  it('does not re-count the cached prefix as fresh input when a later chunk repeats prompt_tokens without the cache detail', () => {
    const first = normalizeOpenAIChatUsage(
      { prompt_tokens: 1000, completion_tokens: 1, cached_tokens: 900 },
      START,
    );
    expect(first).toMatchObject({ input: 100, output: 1, cacheRead: 900 });

    const u = normalizeOpenAIChatUsage({ prompt_tokens: 1000, completion_tokens: 80 }, first);

    expect(u.cacheRead).toBe(900);
    expect(u.input).toBe(100);
    expect(u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)).toBe(1000);
  });

  it('does not re-count a retained cache write as fresh input either', () => {
    const first = normalizeOpenAIChatUsage(
      {
        prompt_tokens: 2000,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 300 },
      },
      START,
    );
    expect(first).toMatchObject({ input: 1200, cacheRead: 500, cacheWrite: 300 });

    const u = normalizeOpenAIChatUsage({ prompt_tokens: 2000, completion_tokens: 60 }, first);

    expect(u.cacheRead).toBe(500);
    expect(u.cacheWrite).toBe(300);
    expect(u.input).toBe(1200);
    expect(u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)).toBe(2000);
  });
});

// ── Through a real adapter stream ───────────────────────────────────────────

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('OpenAI-compatible stream', () => {
  it('reports a Kimi-style cache hit as cacheRead, not fresh input', async () => {
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5000, completion_tokens: 3, cached_tokens: 4800 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const provider = new OpenAICompatibleProvider({
      id: 'kimi-like',
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    const events: StreamEvent[] = [];
    for await (const e of provider.stream(
      {
        model: 'm',
        system: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 8,
      } as unknown as Request,
      { signal: new AbortController().signal },
    )) {
      events.push(e);
    }
    const stop = events.find((e) => e.type === 'message_stop') as
      | { usage: Record<string, number> }
      | undefined;
    expect(stop?.usage).toMatchObject({ input: 200, output: 3, cacheRead: 4800 });
  });
});
