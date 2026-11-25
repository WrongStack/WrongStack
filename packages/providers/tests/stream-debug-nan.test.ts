import { describe, expect, it } from 'vitest';
import {
  defaultDebugStreamCallback,
  pushDebugChunkStats,
  setDebugStreamCallback,
  setDebugStreamEnabled,
} from '../src/stream-debug-state.js';

describe('stream-debug-state non-finite chunk metrics', () => {
  it('sanitizes non-finite byte/delta metrics so totalBytes never becomes NaN', () => {
    let captured = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;

    try {
      setDebugStreamEnabled(true);
      setDebugStreamCallback(defaultDebugStreamCallback);
      pushDebugChunkStats(Number.NaN, Number.NaN);
      pushDebugChunkStats(512, 10);
      setDebugStreamCallback(null);
      setDebugStreamEnabled(false);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(captured).not.toContain('NaN');
    expect(captured).toContain('512B total');
  });
});
