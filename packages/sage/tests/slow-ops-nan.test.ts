import { describe, expect, it } from 'vitest';
import { createSlowOperationReporter } from '../src/project-server-slow-ops.js';

describe('createSlowOperationReporter non-finite duration guard', () => {
  it('ignores NaN and Infinity durationMs instead of logging NaNms', () => {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const report = createSlowOperationReporter(() => ({ pendingRequests: 0, clients: 1 }));
      report('search', Number.NaN);
      report('search', Number.POSITIVE_INFINITY);
      expect(chunks).toEqual([]);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
