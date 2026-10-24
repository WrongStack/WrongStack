/**
 * The stream watchdogs are configurable again: `WireAdapterStreamOptions` has
 * always accepted them, but no host passed them and the composite providers
 * never forwarded them, so both were pinned at 60s whatever the user set.
 */
import type { StreamEvent } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_STREAM_HANG_TIMEOUT_MS,
  resetStreamTimeoutDefaults,
  setStreamTimeoutDefaults,
  streamTimeoutDefaults,
} from '../src/stream-timeouts.js';
import { WireAdapter } from '../src/wire-adapter.js';

class Probe extends WireAdapter {
  override readonly id = 'probe';
  override readonly capabilities = { streaming: true } as never;
  protected override buildUrl(): string {
    return 'https://example.test/v1/chat/completions';
  }
  protected override buildBody(): Record<string, unknown> {
    return {};
  }
  protected override parseStream(): AsyncIterable<StreamEvent> {
    return (async function* () {})();
  }
  /** The two resolved budgets, which are protected on the adapter. */
  budgets(): { hang: number; headers: number } {
    return { hang: this.streamHangTimeoutMs, headers: this.headersTimeoutMs };
  }
}

const probe = (streamOpts?: ConstructorParameters<typeof Probe>[3]) =>
  new Probe('k', 'https://example.test/v1', fetch, streamOpts).budgets();

describe('stream timeout defaults', () => {
  afterEach(() => resetStreamTimeoutDefaults());

  it('falls back to 60s/60s when the host configures nothing', () => {
    expect(probe()).toEqual({
      hang: DEFAULT_STREAM_HANG_TIMEOUT_MS,
      headers: DEFAULT_HEADERS_TIMEOUT_MS,
    });
  });

  it('applies the host-configured budgets to providers built afterwards', () => {
    setStreamTimeoutDefaults({ hangTimeoutMs: 300_000, headersTimeoutMs: 15_000 });
    expect(probe()).toEqual({ hang: 300_000, headers: 15_000 });
  });

  it('honours 0 as "disabled"', () => {
    setStreamTimeoutDefaults({ hangTimeoutMs: 0 });
    expect(probe().hang).toBe(0);
    expect(probe().headers).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
  });

  it('ignores malformed values instead of resurrecting a default', () => {
    setStreamTimeoutDefaults({ hangTimeoutMs: 120_000 });
    setStreamTimeoutDefaults({ hangTimeoutMs: -1 });
    setStreamTimeoutDefaults({ hangTimeoutMs: Number.NaN });
    expect(streamTimeoutDefaults().hangTimeoutMs).toBe(120_000);
  });

  it('lets an explicit per-instance option win', () => {
    setStreamTimeoutDefaults({ hangTimeoutMs: 300_000, headersTimeoutMs: 300_000 });
    expect(probe({ streamHangTimeoutMs: 5_000 })).toEqual({ hang: 5_000, headers: 300_000 });
  });

  it('is read at construction, so a later change only affects new providers', () => {
    const before = new Probe('k', 'https://example.test/v1', fetch);
    setStreamTimeoutDefaults({ hangTimeoutMs: 1_000 });
    expect(before.budgets().hang).toBe(DEFAULT_STREAM_HANG_TIMEOUT_MS);
    expect(probe().hang).toBe(1_000);
  });
});
