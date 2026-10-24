/**
 * `x-codex-routing-hint`. The official client sends `model=<slug>` to the
 * ChatGPT backend on every HTTP request and WebSocket handshake
 * (codex-rs core `build_routing_hint_header`); routing a request to where its
 * model is served is also where its prompt cache lives.
 */

import type { Request } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { OpenAICodexProvider } from '../src/openai-codex.js';
import { CODEX_ROUTING_HINT_HEADER, codexRoutingHint } from '../src/openai-codex-request.js';

describe('codexRoutingHint', () => {
  it('names the model the way the official client does', () => {
    expect(codexRoutingHint('gpt-5.5')).toBe('model=gpt-5.5');
  });

  it('sends nothing without a header-safe model', () => {
    for (const model of [undefined, '', 'has space', 'tab\there', 'ümlaut']) {
      expect(codexRoutingHint(model)).toBeUndefined();
    }
  });
});

describe('OpenAICodexProvider sends the routing hint', () => {
  it('on every Responses request, for the requested model', async () => {
    const seen: Array<string | null> = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: (async (_url: string, init?: { headers?: Record<string, string> }) => {
        seen.push(new Headers(init?.headers).get(CODEX_ROUTING_HINT_HEADER));
        return new Response('data: {"type":"response.completed","response":{}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never as typeof fetch,
    });
    for (const model of ['gpt-5.5', 'gpt-6-astra']) {
      const req: Request = { model, messages: [{ role: 'user', content: 'hi' }] };
      for await (const _ of provider.stream(req, { signal: new AbortController().signal })) {
        // drain
      }
    }
    expect(seen).toEqual(['model=gpt-5.5', 'model=gpt-6-astra']);
  });
});
