import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { stopWin32TreeSuspended, treeKill } from '../../src/utils/tree-kill.js';

const PREFIX = 'tree-kill-spawn-race-';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function childPids(dir: string): Promise<number[]> {
  const names = await readdir(dir);
  return names.filter((n) => /^\d+\.pid$/.test(n)).map((n) => Number.parseInt(n, 10));
}

async function until(probe: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return probe();
}

async function cleanup(dir: string, root: ChildProcess, bystander: ChildProcess): Promise<void> {
  // Ask every fixture process to leave through its own marker, never by PID.
  await writeFile(path.join(dir, 'cleanup.request'), 'stop');
  root.kill('SIGKILL');
  bystander.kill('SIGKILL');
  await until(async () => (await childPids(dir)).every((pid) => !alive(pid)), 5000);
  const target = path.resolve(dir);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith(PREFIX)
  ) {
    throw new Error('Refusing cleanup outside the owned fixture directory');
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const CHILD = `
const fs = require('node:fs'), path = require('node:path');
const stop = () => fs.existsSync(path.join(__dirname, 'cleanup.request'));
fs.writeFileSync(path.join(__dirname, process.pid + '.pid'), String(Date.now()));
setInterval(() => { if (stop()) process.exit(0); }, 25);
setTimeout(() => process.exit(0), 60000);
`;

async function survivors(dir: string): Promise<{ alive: number[]; launched: number }> {
  // Children launched mid-kill need a moment to show up and to die.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await until(async () => (await childPids(dir)).every((pid) => !alive(pid)), 3000);
  const pids = await childPids(dir);
  return { alive: pids.filter(alive), launched: pids.length };
}

it.skipIf(process.platform !== 'win32')(
  'suspend-then-walk stops a root that keeps launching children, and nothing else',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), PREFIX));
    await writeFile(path.join(dir, 'child.cjs'), CHILD);
    const root = path.join(dir, 'root.cjs');
    await writeFile(
      root,
      `
const fs = require('node:fs'), path = require('node:path');
let n = 0;
const timer = setInterval(() => {
  if (fs.existsSync(path.join(__dirname, 'cleanup.request')) || ++n > 400) return clearInterval(timer);
  require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore', windowsHide: true });
}, 20);
`,
    );
    const child = spawn(process.execPath, [root], { cwd: dir, stdio: 'ignore', windowsHide: true });
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(await until(async () => (await childPids(dir)).length >= 3, 15_000)).toBe(true);
      // The helper itself must stop the tree: a silent failure would hand the
      // kill to the taskkill fallback and hide a broken helper.
      const stopped = await new Promise<boolean>((resolve) => {
        if (!stopWin32TreeSuspended(child, { onSettled: resolve })) resolve(false);
      });
      expect(stopped).toBe(true);
      const { alive: left, launched } = await survivors(dir);
      expect(left, `${left.length} of ${launched} children outlived the stop`).toEqual([]);
      expect(child.exitCode ?? child.signalCode).not.toBeNull();
      expect(alive(bystander.pid as number)).toBe(true);
    } finally {
      await cleanup(dir, child, bystander);
    }
  },
  60_000,
);

it.skipIf(process.platform !== 'win32')(
  'treeKill of a shell stopped while it starts its command leaves no orphan',
  async () => {
    // End-to-end guard for the real Windows treeKill path on the case that
    // motivated it: a shell stopped while it starts its command. With
    // `taskkill /T` alone, process_watch stops under vitest orphaned the
    // command (8 of 15), which then held the stdio pipes. This fixture did not
    // reproduce that race against taskkill alone (0 of 30 kills), so it is a
    // regression guard for the helper path, not a red/green proof of the race.
    const dir = await mkdtemp(path.join(os.tmpdir(), PREFIX));
    const command = path.join(dir, 'child.cjs');
    await writeFile(command, CHILD);
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let last: ChildProcess | undefined;
    try {
      for (let trial = 0; trial < 6; trial++) {
        const child = spawn(
          powershell,
          ['-NoProfile', '-NonInteractive', '-Command', `& '${process.execPath}' '${command}'`],
          { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
        last = child;
        child.stdout?.resume();
        child.stderr?.resume();
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
        treeKill(child, { force: true });
        await exited;
      }
      const { alive: left, launched } = await survivors(dir);
      expect(left, `${left.length} of ${launched} commands outlived their shell`).toEqual([]);
      expect(alive(bystander.pid as number)).toBe(true);
    } finally {
      await cleanup(dir, last ?? bystander, bystander);
    }
  },
  120_000,
);

it.skipIf(process.platform !== 'win32')(
  'treeKill falls back to taskkill when the suspend helper cannot start',
  async () => {
    // A restricted host (no Windows PowerShell, blocked Add-Type) must still
    // get the taskkill chain. The helper is resolved under SystemRoot, so a
    // missing SystemRoot makes its launch fail like that.
    const dir = await mkdtemp(path.join(os.tmpdir(), PREFIX));
    await writeFile(path.join(dir, 'child.cjs'), CHILD);
    const root = path.join(dir, 'root.cjs');
    await writeFile(
      root,
      `
const path = require('node:path');
require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore', windowsHide: true });
setTimeout(() => {}, 60000);
`,
    );
    const child = spawn(process.execPath, [root], { cwd: dir, stdio: 'ignore', windowsHide: true });
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(await until(async () => (await childPids(dir)).length === 1, 15_000)).toBe(true);
      const saved = process.env['SystemRoot'];
      process.env['SystemRoot'] = path.join(dir, 'missing');
      try {
        treeKill(child, { force: true });
      } finally {
        // Only the helper's launch reads it; taskkill runs with the real value.
        if (saved === undefined) delete process.env['SystemRoot'];
        else process.env['SystemRoot'] = saved;
      }
      await exited;
      const { alive: left } = await survivors(dir);
      expect(left, 'the descendant outlived the taskkill fallback').toEqual([]);
      expect(alive(bystander.pid as number)).toBe(true);
    } finally {
      await cleanup(dir, child, bystander);
    }
  },
  60_000,
);
