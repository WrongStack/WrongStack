import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reapProcessesUnder } from '../src/sandbox-reaper.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'reaper-prefix-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('reapProcessesUnder sibling prefix boundary (F935)', () => {
  it('reaps exact and nested matches without killing sibling prefix collisions like task-10', async () => {
    const task1 = path.join(root, 'work', 'task-1');
    const task1Child = path.join(root, 'work', 'task-1', 'sub', 'worker.js');
    const task10 = path.join(root, 'work', 'task-10');
    const keepAlive = 'setInterval(() => {}, 1000)';

    const target = spawn(process.execPath, ['-e', keepAlive, task1], { stdio: 'ignore' });
    const child = spawn(process.execPath, ['-e', keepAlive, task1Child], { stdio: 'ignore' });
    const sibling = spawn(process.execPath, ['-e', keepAlive, task10], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const killed = await reapProcessesUnder([task1]);
      expect(killed).toBeGreaterThanOrEqual(2);
      await new Promise((r) => setTimeout(r, 500));
      expect(alive(target.pid as number)).toBe(false);
      expect(alive(child.pid as number)).toBe(false);
      expect(alive(sibling.pid as number)).toBe(true);
    } finally {
      target.kill();
      child.kill();
      sibling.kill();
    }
  }, 60_000);
});
