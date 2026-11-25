import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readPipedStdin } from '../src/boot/piped-stdin.js';

describe('readPipedStdin non-finite option guards', () => {
  it('falls back to defaults when firstByteTimeoutMs or maxBytes is non-finite', async () => {
    const slow = new Readable({ read() {} });
    setTimeout(() => {
      slow.push('delayed');
      slow.push(null);
    }, 30);
    const result = await readPipedStdin(slow, {
      firstByteTimeoutMs: Number.NaN,
      maxBytes: Number.NaN,
    });
    expect(result.timedOut).toBe(false);
    expect(result.text).toBe('delayed');
  });
});
