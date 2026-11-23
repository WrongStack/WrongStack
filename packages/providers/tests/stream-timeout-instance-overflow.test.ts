import type { StreamEvent } from '@wrongstack/contracts/types';
import { afterEach, expect, it } from 'vitest';
import { resetStreamTimeoutDefaults } from '../src/stream-timeouts.js';
import { WireAdapter, type WireAdapterStreamOptions } from '../src/wire-adapter.js';

/**
 * F1377: a per-instance `streamOpts` budget must get the same clamp as a
 * host-configured one (`stream-timeout-overflow.test.ts`). Node turns a timer
 * delay past 2_147_483_647 ms — or a non-finite one — into 1 ms, so an
 * unclamped budget meant "time out immediately", not "practically never".
 */
class Probe extends WireAdapter {
  override readonly id = 'instance-timeout-overflow';
  override readonly capabilities = { streaming: true } as never;
  protected override buildUrl() {
    return 'https://example.test/stream';
  }
  protected override buildBody() {
    return {};
  }
  protected override async *parseStream(): AsyncIterable<StreamEvent> {}
}

async function requestedTimers(streamOpts: WireAdapterStreamOptions): Promise<number[]> {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    delays.push(Number(args[1]));
    return original(...args);
  }) as typeof setTimeout;
  try {
    const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch;
    const provider = new Probe('test', 'https://example.test', fetchImpl, streamOpts);
    for await (const _event of provider.stream(
      { model: 'm', messages: [], maxTokens: 1 },
      { signal: new AbortController().signal },
    )) {
    }
    return delays;
  } finally {
    globalThis.setTimeout = original;
  }
}

afterEach(() => resetStreamTimeoutDefaults());

it.each([2_147_483_648, 3_000_000_000, Number.MAX_SAFE_INTEGER])(
  'clamps an explicit %s ms header watchdog instead of firing it in 1 ms',
  async (value) => {
    resetStreamTimeoutDefaults();
    expect(await requestedTimers({ headersTimeoutMs: value, streamHangTimeoutMs: 0 })).toEqual([
      2_147_483_647,
    ]);
  },
);

it('treats a non-finite explicit header watchdog as unset (host default)', async () => {
  resetStreamTimeoutDefaults();
  expect(
    await requestedTimers({ headersTimeoutMs: Number.POSITIVE_INFINITY, streamHangTimeoutMs: 0 }),
  ).toEqual([60_000]);
});

it('never arms a 0 ms hang watchdog for a non-finite explicit budget', async () => {
  resetStreamTimeoutDefaults();
  const delays = await requestedTimers({
    headersTimeoutMs: 0,
    streamHangTimeoutMs: Number.POSITIVE_INFINITY,
  });
  expect(delays.length).toBeGreaterThan(0);
  expect(delays.every((delay) => delay === 60_000)).toBe(true);
});

it.each([0, 120_000, 2_147_483_647])('keeps a supported explicit %s ms budget', async (value) => {
  resetStreamTimeoutDefaults();
  expect(await requestedTimers({ headersTimeoutMs: value, streamHangTimeoutMs: 0 })).toEqual(
    value === 0 ? [] : [value],
  );
});
