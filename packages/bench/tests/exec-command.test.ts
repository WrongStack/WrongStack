import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec-command.js';

const NODE = process.execPath;

/** Liveness of the exact descendant PID recorded by our fixture. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('execCommand', () => {
  it('captures stdout and a zero exit code (no shell)', async () => {
    const res = await execCommand({
      command: NODE,
      args: ['-e', "process.stdout.write('hello')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('hello');
    expect(res.timedOut).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const res = await execCommand({
      command: NODE,
      args: ['-e', "process.stderr.write('boom'); process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('boom');
  });

  it('runs through a shell, quoting args with whitespace', async () => {
    // 'space arg' contains whitespace → exercises the shellQuote wrapping path.
    // Assert only the exit code (stdout through cmd/sh quoting is not portable).
    const res = await execCommand({
      command: 'node', // bare name resolves via PATH; absolute execPath may contain spaces
      args: ['-e', 'undefined', 'space arg'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: true,
    });
    expect(res.exitCode).toBe(0);
  });

  it('defaults to shell mode when shell is omitted', async () => {
    const res = await execCommand({
      command: 'node',
      args: ['-e', 'undefined'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
  });

  it('reports a spawn error as exitCode null (nonexistent binary)', async () => {
    const res = await execCommand({
      command: 'this-binary-does-not-exist-xyz',
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(res.exitCode).toBeNull();
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('kills a command that exceeds the timeout', async () => {
    const res = await execCommand({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: process.cwd(),
      timeoutMs: 150,
      shell: false,
    });
    expect(res.timedOut).toBe(true);
  });

  it(
    'settles a timed-out shell command whose grandchild holds the pipes',
    async () => {
      // npm → cmd.exe → jest stuck in a solution's infinite loop: killing the
      // shell first orphaned jest, which kept stdout open, so `close` never came
      // and the grader hung the bench run. Same shape: shell → node → busy loop.
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-orphan-'));
      const marker = `busy-${process.pid}-${Date.now()}.cjs`;
      await fs.writeFile(
        path.join(dir, marker),
        `if (process.argv.includes('--child')) { const deadline = Date.now() + 60000; while (Date.now() < deadline) {} }
else {
  const child = require('node:child_process').spawn(process.execPath, [__filename, '--child'], { stdio: 'inherit' });
  require('node:fs').writeFileSync('child.pid', String(child.pid));
}
`,
        'utf8',
      );
      const started = Date.now();
      const res = await execCommand({
        command: 'node',
        args: [marker],
        cwd: dir,
        timeoutMs: 2000,
      });
      expect(res.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(
        process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + 5000 : 15_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // A global synchronous CIM scan could outlive the test timeout itself.
      // The fixture records its actual descendant, so assert its liveness directly.
      const descendantPid = Number(await fs.readFile(path.join(dir, 'child.pid'), 'utf8'));
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      const survivors = isProcessAlive(descendantPid) ? [descendantPid] : [];
      // The fixture self-terminates after 60s if the production kill is broken;
      // never signal a potentially recycled PID during failure cleanup.
      // Assert before cleanup so a leaked descendant's cwd lock cannot mask it.
      expect(survivors).toEqual([]);
      await fs.rm(dir, { recursive: true, force: true });
    },
    process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + 15_000 : 30_000,
  );

  it('surfaces a synchronous spawn failure as exitCode null', async () => {
    // A NUL byte in the command makes spawn throw synchronously, exercising the
    // try/catch around spawn rather than the async 'error' event.
    const res = await execCommand({
      command: `bad${String.fromCharCode(0)}cmd`,
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(res.exitCode).toBeNull();
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('truncates and kills a command that exceeds maxBufferBytes', async () => {
    // Emit far more than the cap, then keep the process alive so it only ends
    // because the buffer guard tree-kills it (not because it finished cleanly).
    const res = await execCommand({
      command: NODE,
      args: ['-e', "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 30000);"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
      maxBufferBytes: 1000,
    });
    expect(res.truncated).toBe(true);
    // Capture stopped at the cap rather than buffering all 200k bytes.
    expect(res.stdout.length).toBeLessThanOrEqual(1000);
    // The guard killed the tree well before the 10s timeout, so timedOut stays false.
    expect(res.timedOut).toBe(false);
  });

  it('does not flag truncated for small output under the cap', async () => {
    const res = await execCommand({
      command: NODE,
      args: ['-e', "process.stdout.write('hi')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
      maxBufferBytes: 1000,
    });
    expect(res.truncated).toBe(false);
    expect(res.stdout).toBe('hi');
  });

  it('reports synchronous spawn errors as exitCode null', async () => {
    const res = await execCommand({
      command: `bad${String.fromCharCode(0)}cmd`,
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toMatch(/null|EINVAL|ERR_INVALID_ARG_VALUE/);
  });
});
