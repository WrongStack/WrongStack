import type { Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  createSetupProviderFactory,
  isSetupProvider,
  SETUP_MODEL_ID,
  SETUP_PROVIDER_ID,
  setupProviderResolved,
} from '../src/setup-provider.js';

function request(overrides: Partial<Request> = {}): Request {
  return { model: SETUP_MODEL_ID, messages: [], ...overrides };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function streamedText(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
}

describe('setup provider', () => {
  it('identifies only its own id', () => {
    expect(isSetupProvider(SETUP_PROVIDER_ID)).toBe(true);
    expect(isSetupProvider('anthropic')).toBe(false);
    expect(isSetupProvider(undefined)).toBe(false);
  });

  it('constructs with no credential of any kind', () => {
    // The whole point: a machine with no key, no token and no local server
    // must still be able to build a working Provider.
    const provider = createSetupProviderFactory().create({ type: SETUP_PROVIDER_ID });
    expect(provider.id).toBe(SETUP_PROVIDER_ID);
  });

  it('keeps the user-visible id from cfg.type', () => {
    const provider = createSetupProviderFactory().create({ type: 'my-alias' });
    expect(provider.id).toBe('my-alias');
  });

  it('streams a well-formed message that names the way out', async () => {
    const provider = createSetupProviderFactory().create({ type: SETUP_PROVIDER_ID });
    const events = await collect(
      provider.stream(request(), { signal: new AbortController().signal }),
    );

    expect(events[0]).toEqual({ type: 'message_start', model: SETUP_MODEL_ID });
    expect(events.at(-1)).toEqual({
      type: 'message_stop',
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
    });
    // The reply's only job is to route the user to a credential flow.
    expect(streamedText(events)).toContain('/auth');
    expect(streamedText(events)).toContain('setup mode');
  });

  it('stops emitting deltas once aborted but still closes the stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createSetupProviderFactory().create({ type: SETUP_PROVIDER_ID });
    const events = await collect(provider.stream(request(), { signal: controller.signal }));

    expect(streamedText(events)).toBe('');
    // A dangling stream would hang the agent loop — the terminators must ship.
    expect(events.some((e) => e.type === 'content_block_stop')).toBe(true);
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('completes non-streaming with the same text and zero usage', async () => {
    const provider = createSetupProviderFactory().create({ type: SETUP_PROVIDER_ID });
    const response = await provider.complete(request({ model: 'anything' }), {
      signal: new AbortController().signal,
    });

    expect(response.stopReason).toBe('end_turn');
    // Zero usage matters: setup mode never bills and must never look like it did.
    expect(response.usage).toEqual({ input: 0, output: 0 });
    expect(response.model).toBe('anything');
    expect(response.content[0]).toMatchObject({ type: 'text' });
  });

  it('advertises a non-zero context window', () => {
    // maxContext: 0 would make every context-fullness computation divide by
    // zero on the one surface a brand-new user is looking at.
    const provider = createSetupProviderFactory().create({ type: SETUP_PROVIDER_ID });
    expect(provider.capabilities.maxContext).toBeGreaterThan(0);
    expect(provider.capabilities.streaming).toBe(true);
  });

  it('resolves to a catalog shape with exactly one model and no env vars', () => {
    const resolved = setupProviderResolved();
    expect(resolved.id).toBe(SETUP_PROVIDER_ID);
    expect(resolved.envVars).toEqual([]);
    expect(resolved.models.map((m) => m.id)).toEqual([SETUP_MODEL_ID]);
    // No apiBase — nothing here ever reaches the network.
    expect(resolved.apiBase).toBeUndefined();
  });
});
