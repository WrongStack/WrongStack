import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { settleWin32Kill } from '../../src/utils/tree-kill.js';
import { buildWin32CmdShimInvocation } from '../../src/utils/win32-cmd.js';

function firstOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not start')), 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout!.once('data', (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function cleanupFixture(
  dir: string,
  descendantPid: number | undefined,
  closed: Promise<void>,
) {
  // Request fixture shutdown through its own marker, never an arbitrary PID.
  await writeFile(path.join(dir, 'cleanup.request'), 'stop');
  const cleanupDeadline = Date.now() + 5000;
  while (descendantPid !== undefined && alive(descendantPid) && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await closed;
  const target = path.resolve(dir);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('tree-kill-fallback-')
  ) {
    throw new Error('Refusing cleanup outside the owned fixture directory');
  }
  // Bun may not honor fs.rm's built-in Windows retry options.
  for (;;) {
    try {
      await rm(target, { recursive: true, force: true });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || Date.now() >= cleanupDeadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

it.skipIf(process.platform !== 'win32')(
  'cleans the real descendant before the direct-handle fallback and spares a bystander',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tree-kill-fallback-'));
    const file = path.join(dir, 'fixture.cjs');
    await writeFile(
      file,
      `
if (process.argv.includes('--descendant')) {
 require('node:fs').writeFileSync('descendant.pid',String(process.pid));
 setInterval(()=>{ if(require('node:fs').existsSync('cleanup.request')) process.exit(0); },25);
 setTimeout(()=>process.exit(0),60000);
} else {
 require('node:child_process').spawn(process.execPath,[__filename,'--descendant'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
}
`,
    );
    const shimFile = path.join(dir, 'fixture.cmd');
    await writeFile(shimFile, '@ECHO off\r\nnode "%~dp0fixture.cjs"\r\n');
    const shim = buildWin32CmdShimInvocation(shimFile, []);
    const child = spawn(shim.command, shim.args, {
      cwd: dir,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
    });
    const bystander = spawn(
      'node',
      ['-e', 'process.stdout.write("ready");setTimeout(()=>{},60000)'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let descendantPid: number | undefined;
    try {
      const readyDeadline = Date.now() + 5000;
      while (Date.now() < readyDeadline) {
        try {
          descendantPid = Number(await readFile(path.join(dir, 'descendant.pid'), 'utf8'));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(descendantPid).toBeGreaterThan(0);
      if (descendantPid === undefined) throw new Error('descendant did not start');
      await firstOutput(bystander);
      expect(alive(descendantPid)).toBe(true);
      expect(bystander.exitCode).toBeNull();
      const killer = Object.assign(new EventEmitter(), { unref() {} });
      // The external taskkill never settles. Exercise the real fallback with a
      // short injected backstop, without mocking the suspect cleanup function.
      settleWin32Kill(killer, child, () => child.kill(), 200);
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(alive(descendantPid), 'a stopped wrapper must not orphan its descendant').toBe(false);
      expect(bystander.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
      bystander.kill('SIGKILL');
      await cleanupFixture(dir, descendantPid, closed);
    }
  },
  20_000,
);
