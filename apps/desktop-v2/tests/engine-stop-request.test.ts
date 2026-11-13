import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchStopRequest } from '../engine/stop-request';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('engine stop request', () => {
  it('stops once when the host writes the stop file, and removes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-stop-'));
    dirs.push(dir);
    const path = join(dir, 'x.stop');
    let stops = 0;
    const dispose = watchStopRequest(path, () => stops++, { pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stops).toBe(0);
    writeFileSync(path, '');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stops).toBe(1);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stops, 'the watch ends after the first request').toBe(1);
    dispose();
  });
});
