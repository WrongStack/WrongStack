import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePredictionsJsonl } from '../src/report/predictions.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pred-extra-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writePredictionsJsonl', () => {
  it('writes an empty file for no predictions (no trailing newline)', async () => {
    const file = await writePredictionsJsonl(dir, 'opus', []);
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('writes one JSON line per prediction with a trailing newline', async () => {
    const file = await writePredictionsJsonl(dir, 'opus', [
      { instance_id: 'i1', model_patch: 'p', model_name_or_path: 'opus' },
    ] as never);
    const body = await fs.readFile(file, 'utf8');
    expect(body.endsWith('\n')).toBe(true);
    expect(body.trim().split('\n')).toHaveLength(1);
  });

  it('slugifies the cell label, falling back to "cell" for empty slugs', async () => {
    const file = await writePredictionsJsonl(dir, '@@@', []);
    expect(path.basename(file)).toBe('predictions-cell.jsonl');
  });
});
