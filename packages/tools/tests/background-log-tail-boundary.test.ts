import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tailBackgroundLog } from '../src/background-log.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('tailBackgroundLog maxLines boundary', () => {
  it('returns an empty array when maxLines is zero, negative, or non-finite', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-log-tail-'));
    dirs.push(dir);
    const file = path.join(dir, 'run.log');
    await fs.writeFile(file, 'line1\nline2\nline3\n', 'utf8');

    expect(tailBackgroundLog(file, 0)).toEqual([]);
    expect(tailBackgroundLog(file, -2)).toEqual([]);
    expect(tailBackgroundLog(file, Number.NaN)).toEqual([]);
    expect(tailBackgroundLog(file, 2)).toEqual(['line2', 'line3']);
  });
});
