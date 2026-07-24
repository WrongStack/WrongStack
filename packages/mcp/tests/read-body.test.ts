import { describe, expect, it, vi } from 'vitest';
import { readBodyCapped } from '../src/read-body.js';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('readBodyCapped', () => {
  it('returns the full text when under the cap', async () => {
    const res = {
      body: streamOf([new TextEncoder().encode('hello world')]),
      text: async () => 'unused',
    };
    expect(await readBodyCapped(res, 1024)).toBe('hello world');
  });

  it('throws once the streamed body exceeds the cap (OOM guard)', async () => {
    const chunk = new Uint8Array(100);
    const res = {
      body: streamOf(Array.from({ length: 20 }, () => chunk)), // 2000 bytes
      text: async () => 'unused',
    };
    await expect(readBodyCapped(res, 500)).rejects.toThrow(/exceeded/i);
  });

  it('falls back to res.text() when the body is not a web stream', async () => {
    expect(await readBodyCapped({ body: null, text: async () => 'fallback' })).toBe('fallback');
  });

  it('ignores an empty stream chunk', async () => {
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: undefined })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    };
    const response = {
      body: { getReader: () => reader },
      text: async () => 'unused',
    };

    await expect(readBodyCapped(response as never, 10)).resolves.toBe('');
  });

  it('still rejects an oversized body when cancelling the reader fails', async () => {
    const reader = {
      read: vi.fn(async () => ({ done: false, value: new Uint8Array(11) })),
      cancel: vi.fn(async () => {
        throw new Error('cancel failed');
      }),
    };
    const response = {
      body: { getReader: () => reader },
      text: async () => 'unused',
    };

    await expect(readBodyCapped(response as never, 10)).rejects.toThrow(/exceeded/i);
  });
});
