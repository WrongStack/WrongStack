import type { StreamEvent } from '@wrongstack/contracts/types';
import {
  resetStreamTimeoutDefaults,
  setStreamTimeoutDefaults,
  streamTimeoutDefaults,
} from '../../src/stream-timeouts.js';
import { WireAdapter } from '../../src/wire-adapter.js';

class Probe extends WireAdapter {
  override readonly id = 'timeout-overflow';
  override readonly capabilities = { streaming: true } as never;
  protected override buildUrl() {
    return 'https://example.test/stream';
  }
  protected override buildBody() {
    return {};
  }
  protected override async *parseStream(): AsyncIterable<StreamEvent> {}
}

export async function streamTimeoutOverflow(value: number) {
  const original = globalThis.setTimeout;
  const timers: Array<{ requested: number | undefined; effective: number | undefined }> = [];
  resetStreamTimeoutDefaults();
  setStreamTimeoutDefaults({ headersTimeoutMs: value, hangTimeoutMs: 0 });
  const configured = streamTimeoutDefaults().headersTimeoutMs;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = original(...args);
    timers.push({
      requested: args[1],
      effective: (timer as unknown as { _idleTimeout?: number })._idleTimeout,
    });
    return timer;
  }) as typeof setTimeout;
  try {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const provider = new Probe('test', 'https://example.test', fetchImpl);
    for await (const _event of provider.stream(
      { model: 'm', messages: [], maxTokens: 1 },
      { signal: new AbortController().signal },
    )) {
    }
    return { configured, timers };
  } finally {
    globalThis.setTimeout = original;
    resetStreamTimeoutDefaults();
  }
}
