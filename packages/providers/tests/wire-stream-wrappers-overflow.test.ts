import { describe, expect, it } from 'vitest';
import { wrapWithHangDetection } from '../src/wire-stream-wrappers.js';

describe('wrapWithHangDetection timeout clamping (F384)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of firing hang error in 1ms', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        }, 30);
      },
    });

    const wrapped = wrapWithHangDetection(stream, {
      providerId: 'openai',
      model: 'gpt-5',
      timeoutMs: 3_000_000_000,
    }) as ReadableStream<Uint8Array>;

    const reader = wrapped.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });
});
