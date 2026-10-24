/**
 * zstd request compression for the ChatGPT Codex backend. The official client
 * compresses by default (`enable_request_compression`, zstd level 3,
 * `content-encoding: zstd`) and only for its own backend; the backend was
 * verified live (2026-09-30) to decode it. A proxy or custom base URL gets the
 * plain JSON, since it may not understand zstd.
 */

import { zstdDecompressSync } from 'node:zlib';
import type { Request } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import { compressCodexRequestBody } from '../src/openai-codex-request.js';

const OFFICIAL = 'https://chatgpt.com/backend-api';
const large = JSON.stringify({ instructions: 'x'.repeat(50_000) });

describe('compressCodexRequestBody', () => {
  it('compresses a large body for the official backend and says so', () => {
    const headers: Record<string, string> = {};
    const out = compressCodexRequestBody(large, headers, OFFICIAL);
    expect(headers['content-encoding']).toBe('zstd');
    expect(typeof out).not.toBe('string');
    expect((out as Uint8Array).length).toBeLessThan(large.length / 10);
    expect(zstdDecompressSync(out as Uint8Array).toString('utf8')).toBe(large);
  });

  it('leaves the body and headers alone where compression is not safe or not worth it', () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ['small body', '{"a":1}', {}],
      ['custom base URL', large, {}],
      ['encoding already set', large, { 'Content-Encoding': 'gzip' }],
    ];
    for (const [label, json, headers] of cases) {
      const before = { ...headers };
      const base = label === 'custom base URL' ? 'https://proxy.example.test/codex' : OFFICIAL;
      expect(compressCodexRequestBody(json, headers, base), label).toBe(json);
      expect(headers, label).toEqual(before);
    }
  });

  it('falls back to plain JSON on a runtime without zstd or a failing compressor', () => {
    const noZstd: Record<string, string> = {};
    expect(compressCodexRequestBody(large, noZstd, OFFICIAL, null)).toBe(large);
    expect(noZstd).toEqual({});

    const failing: Record<string, string> = {};
    const out = compressCodexRequestBody(large, failing, OFFICIAL, () => {
      throw new Error('boom');
    });
    expect(out).toBe(large);
    expect(failing).toEqual({});
  });
});

describe('OpenAICodexProvider puts the compressed body on the wire', () => {
  function capture(baseUrl?: string) {
    const seen: Array<{ encoding: string | null; json: string }> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      ...(baseUrl ? { baseUrl } : {}),
      fetchImpl: (async (
        _url: string,
        init?: { body?: unknown; headers?: ConstructorParameters<typeof Headers>[0] },
      ) => {
        const encoding = new Headers(init?.headers).get('content-encoding');
        const body = init?.body;
        seen.push({
          encoding,
          json:
            typeof body === 'string'
              ? body
              : zstdDecompressSync(body as Uint8Array).toString('utf8'),
        });
        return new Response('data: {"type":"response.completed","response":{}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never as typeof fetch,
    });
    return { provider, seen };
  }

  const req: Request = {
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'y'.repeat(40_000) }],
  };

  async function send(provider: OpenAICodexProvider): Promise<void> {
    for await (const _ of provider.stream(req, { signal: new AbortController().signal })) {
      // drain
    }
  }

  it('compresses a real-sized turn to the default backend without changing it', async () => {
    const { provider, seen } = capture();
    await send(provider);
    expect(seen[0]?.encoding).toBe('zstd');
    expect(JSON.parse(seen[0]?.json ?? '{}')).toMatchObject({ model: 'gpt-5.5', store: false });
  });

  it('sends plain JSON to a custom base URL', async () => {
    const { provider, seen } = capture('https://proxy.example.test/backend-api');
    await send(provider);
    expect(seen[0]?.encoding).toBeNull();
    expect(JSON.parse(seen[0]?.json ?? '{}')).toMatchObject({ model: 'gpt-5.5' });
  });
});
