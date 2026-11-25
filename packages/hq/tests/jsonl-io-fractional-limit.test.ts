import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTailNonEmptyLines } from '../src/persistence/jsonl-io.js';

describe('readTailNonEmptyLines fractional limit handling (F1847)', () => {
  it('floors finite limits so fractional limits below 1 return [] while Infinity reads all lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-jsonl-frac-'));
    try {
      const file = path.join(dir, 'log.jsonl');
      await fs.writeFile(file, '{"i":1}\n{"i":2}\n{"i":3}\n', 'utf8');

      expect(await readTailNonEmptyLines(file, 0.5, 3)).toEqual([]);
      expect(await readTailNonEmptyLines(file, 1.9, 3)).toHaveLength(1);
      expect(await readTailNonEmptyLines(file, Number.POSITIVE_INFINITY, 3)).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
