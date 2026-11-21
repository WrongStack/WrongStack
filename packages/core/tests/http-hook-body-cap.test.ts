import { afterEach, describe, expect, it } from 'vitest';
import { runHttpHookDetailed } from '../src/hooks/http-executor.js';

describe('runHttpHookDetailed streaming body cap (F941)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('cancels oversized streamed responses as soon as the 64 KiB cap is exceeded', async () => {
    let chunksPulled = 0;
    let streamCancelled = false;
    const chunk = new Uint8Array(32 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksPulled >= 10) {
          controller.close();
          return;
        }
        chunksPulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        streamCancelled = true;
      },
    });
    globalThis.fetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await runHttpHookDetailed(
      { url: 'http://127.0.0.1:9999/hook', timeoutMs: 2_000 },
      { event: 'PreToolUse', toolName: 'bash', toolInput: {} } as never,
    );

    expect(result.outcome).toBeNull();
    expect(result.failure?.kind).toBe('invalid_output');
    expect(chunksPulled).toBeLessThanOrEqual(4);
    expect(streamCancelled).toBe(true);
  });

  it('accepts valid JSON responses up to the 64 KiB cap and cancels non-2xx body streams', async () => {
    const base = '{"decision":"allow"}';
    const exact64k = base + ' '.repeat(64 * 1024 - base.length);
    globalThis.fetch = (async () =>
      new Response(exact64k, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const exact = await runHttpHookDetailed(
      { url: 'http://127.0.0.1:9999/hook', timeoutMs: 2_000 },
      { event: 'PreToolUse', toolName: 'bash', toolInput: {} } as never,
    );
    expect(exact.failure).toBeUndefined();
    expect(exact.outcome).not.toBeNull();

    let errCancelled = false;
    const errStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        errCancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(errStream, { status: 502 })) as typeof fetch;

    const errRes = await runHttpHookDetailed(
      { url: 'http://127.0.0.1:9999/hook', timeoutMs: 2_000 },
      { event: 'PreToolUse', toolName: 'bash', toolInput: {} } as never,
    );
    expect(errRes.failure?.kind).toBe('error');
    expect(errCancelled).toBe(true);
  });
});
