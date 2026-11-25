import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTranscriptTail } from '../src/session-recap/transcript-tail.js';

describe('readTranscriptTail non-finite count guard', () => {
  it('returns empty array when n is NaN or Infinity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-tr-t-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"type":"user","content":"a"}\n{"type":"assistant","content":"b"}\n');
    try {
      expect(await readTranscriptTail(file, Number.NaN)).toEqual([]);
      expect(await readTranscriptTail(file, Number.POSITIVE_INFINITY)).toEqual([]);
      expect(await readTranscriptTail(file, 1)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
