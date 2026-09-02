import { describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec-command.js';

const NODE = process.execPath;

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
});
