/**
 * MiniMax goes silent for over a minute while emitting a large tool call and
 * Z.AI can take over a minute to send headers, so the 60s watchdogs failed
 * those turns on all four attempts. Their floor applies only where nobody
 * chose a value.
 */
import type { StreamEvent } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SLOW_BACKEND_HANG_TIMEOUT_MS,
  SLOW_BACKEND_HEADERS_TIMEOUT_MS,
} from '../src/stream-timeout-floors.js';
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_STREAM_HANG_TIMEOUT_MS,
  resetStreamTimeoutDefaults,
  setStreamTimeoutDefaults,
} from '../src/stream-timeouts.js';
import { WireAdapter } from '../src/wire-adapter.js';

function probe(
  id: string,
  baseUrl: string,
  streamOpts?: ConstructorParameters<typeof WireAdapter>[3],
): { hang: number; headers: number } {
  class Probe extends WireAdapter {
    override readonly id = id;
    override readonly capabilities = { streaming: true } as never;
    protected override buildUrl(): string {
      return `${baseUrl}/chat/completions`;
    }
    protected override buildBody(): Record<string, unknown> {
      return {};
    }
    protected override parseStream(): AsyncIterable<StreamEvent> {
      return (async function* () {})();
    }
    budgets() {
      return { hang: this.streamHangTimeoutMs, headers: this.headersTimeoutMs };
    }
  }
  return new Probe('k', baseUrl, fetch, streamOpts).budgets();
}

const SLOW = { hang: SLOW_BACKEND_HANG_TIMEOUT_MS, headers: SLOW_BACKEND_HEADERS_TIMEOUT_MS };
const DEFAULT = { hang: DEFAULT_STREAM_HANG_TIMEOUT_MS, headers: DEFAULT_HEADERS_TIMEOUT_MS };

describe('slow backend stream floors', () => {
  afterEach(() => resetStreamTimeoutDefaults());

  it.each([
    ['minimax-coding-plan', 'https://api.minimax.io/anthropic'],
    ['minimax-cn', 'https://api.minimaxi.com/v1'],
    ['zai-coding-plan', 'https://api.z.ai/api/coding/paas/v4'],
    ['my-glm', 'https://open.bigmodel.cn/api/paas/v4'],
  ])('raises the built-in budgets for %s', (id, url) => {
    expect(probe(id, url)).toEqual(SLOW);
  });

  it('leaves other backends on the built-in budgets', () => {
    expect(probe('openai', 'https://api.openai.com/v1')).toEqual(DEFAULT);
    expect(probe('minimaxish', 'https://example.test/v1')).toEqual(DEFAULT);
  });

  it('keeps a host-configured budget, including 0', () => {
    setStreamTimeoutDefaults({ hangTimeoutMs: 90_000, headersTimeoutMs: 0 });
    expect(probe('minimax-coding-plan', 'https://api.minimax.io/anthropic')).toEqual({
      hang: 90_000,
      headers: 0,
    });
  });

  it('keeps an explicit per-instance option even when it equals the default', () => {
    expect(
      probe('zai-coding-plan', 'https://api.z.ai/api/coding/paas/v4', {
        streamHangTimeoutMs: DEFAULT_STREAM_HANG_TIMEOUT_MS,
      }),
    ).toEqual({ hang: DEFAULT_STREAM_HANG_TIMEOUT_MS, headers: SLOW_BACKEND_HEADERS_TIMEOUT_MS });
  });
});
