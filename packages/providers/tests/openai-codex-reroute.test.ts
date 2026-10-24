/**
 * Server-side model reroute. The ChatGPT backend can answer with another model
 * than the one requested (accounts flagged for high-risk cyber activity are
 * routed to a fallback) and reports it only in `openai-model`. The official
 * client reads it from the HTTP response headers, from `response.headers` on a
 * stream event, and from `headers` on a WebSocket metadata frame, and warns
 * when it differs from the requested slug. A model-name diff is never used:
 * providers resolve aliases, so it would fire on every healthy response.
 */

import type { Request, StreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { aggregateStream } from '../src/aggregate.js';
import { OpenAICodexProvider, parseOpenAIResponsesStream } from '../src/openai-codex.js';
import { CODEX_REROUTE_REASON } from '../src/openai-codex-errors.js';

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const COMPLETED = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

function reroutes(events: StreamEvent[]): StreamEvent[] {
  return events.filter((e) => e.type === 'model_rerouted');
}

describe('parseOpenAIResponsesStream reports a server-side reroute', () => {
  it('reads openai-model from an event’s response.headers', async () => {
    const events = await collect(
      parseOpenAIResponsesStream(
        sseBody(
          `data: {"type":"response.created","response":{"model":"gpt-5.3-codex","headers":{"OpenAI-Model":"gpt-5.2"}}}\n\n${COMPLETED}`,
        ),
        'gpt-5.3-codex',
        'openai-codex',
      ),
    );
    expect(reroutes(events)).toEqual([
      { type: 'model_rerouted', requested: 'gpt-5.3-codex', served: 'gpt-5.2' },
    ]);
  });

  it('reads it from a WebSocket metadata frame’s headers', async () => {
    const events = await collect(
      parseOpenAIResponsesStream(
        sseBody(
          `data: {"type":"response.metadata","headers":{"x-openai-model":"gpt-5.2"}}\n\n${COMPLETED}`,
        ),
        'gpt-5.3-codex',
        'openai-codex',
      ),
    );
    expect(reroutes(events)).toHaveLength(1);
  });

  it('reports a reroute once, however many events restate it', async () => {
    const frame = 'data: {"type":"response.metadata","headers":{"openai-model":"gpt-5.2"}}\n\n';
    const events = await collect(
      parseOpenAIResponsesStream(
        sseBody(`${frame}${frame}${COMPLETED}`),
        'gpt-5.3-codex',
        'openai-codex',
      ),
    );
    expect(reroutes(events)).toHaveLength(1);
  });

  it('stays silent when the server model is the requested one (case-insensitively)', async () => {
    const events = await collect(
      parseOpenAIResponsesStream(
        sseBody(
          `data: {"type":"response.metadata","headers":{"openai-model":"GPT-5.3-Codex"}}\n\n${COMPLETED}`,
        ),
        'gpt-5.3-codex',
        'openai-codex',
      ),
    );
    expect(reroutes(events)).toEqual([]);
  });

  it('never infers a reroute from response.model alone', async () => {
    // Providers resolve aliases; only the explicit header is evidence.
    const events = await collect(
      parseOpenAIResponsesStream(
        sseBody(
          `data: {"type":"response.created","response":{"model":"gpt-5.3-codex-2026-09-01"}}\n\n${COMPLETED}`,
        ),
        'gpt-5.3-codex',
        'openai-codex',
      ),
    );
    expect(reroutes(events)).toEqual([]);
  });
});

describe('OpenAICodexProvider surfaces the reroute from its HTTP headers', () => {
  const req: Request = { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }] };

  function providerAnswering(servedModel: string | undefined): OpenAICodexProvider {
    return new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: (async () =>
        new Response(
          sseBody(
            `data: {"type":"response.created","response":{"model":"gpt-5.3-codex"}}\n\n${COMPLETED}`,
          ),
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              ...(servedModel ? { 'openai-model': servedModel } : {}),
            },
          },
        )) as never as typeof fetch,
    });
  }

  it('emits model_rerouted with the backend’s explanation', async () => {
    const events = await collect(
      providerAnswering('gpt-5.2').stream(req, { signal: new AbortController().signal }),
    );
    expect(reroutes(events)).toEqual([
      {
        type: 'model_rerouted',
        requested: 'gpt-5.3-codex',
        served: 'gpt-5.2',
        reason: CODEX_REROUTE_REASON,
      },
    ]);
  });

  it('emits nothing when the header matches or is absent', async () => {
    for (const served of ['gpt-5.3-codex', undefined]) {
      const events = await collect(
        providerAnswering(served).stream(req, { signal: new AbortController().signal }),
      );
      expect(reroutes(events)).toEqual([]);
    }
  });

  it('carries the reroute onto the aggregated Response', async () => {
    const response = await aggregateStream(
      providerAnswering('gpt-5.2').stream(req, { signal: new AbortController().signal }),
    );
    expect(response.rerouted).toEqual({
      requested: 'gpt-5.3-codex',
      served: 'gpt-5.2',
      reason: CODEX_REROUTE_REASON,
    });
  });
});
