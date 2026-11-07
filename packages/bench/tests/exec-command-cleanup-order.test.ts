import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, killTree } = vi.hoisted(() => ({ spawnMock: vi.fn(), killTree: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../src/runner.js', () => ({ treeKill: killTree }));
vi.mock('../src/child-env.js', () => ({ inheritedEnv: () => ({}) }));

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.useRealTimers();
  spawnMock.mockReset();
  killTree.mockReset();
});
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    stdin: { destroy: vi.fn() },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  spawnMock.mockReturnValue(child);
  return child;
}
describe('benchmark Windows timeout cleanup ordering', () => {
  it('does not finish while the Windows tree is still being stopped', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Load platform-specific policy after selecting the mocked host, also on POSIX CI.
    const { execCommand } = await import('../src/exec-command.js');
    const child = fixture();
    let settled = false;
    const pending = execCommand({
      command: 'fixture',
      args: [],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 100,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
    expect(settled).toBe(false);
    child.exitCode = 1;
    child.emit('close', 1);
    expect((await pending).timedOut).toBe(true);
  });
  it('keeps buffer overflow as the cause while Windows cleanup passes the command deadline', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { execCommand } = await import('../src/exec-command.js');
    const child = fixture();
    let settled = false;
    const pending = execCommand({
      command: 'fixture',
      args: [],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 1000,
      maxBufferBytes: 1,
    }).then((value) => {
      settled = true;
      return value;
    });
    child.stdout.write(Buffer.from('overflow'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(settled).toBe(false);
    child.exitCode = 1;
    child.emit('close', 1);
    expect(await pending).toMatchObject({ timedOut: false, truncated: true, exitCode: 1 });
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('keeps caller cancellation distinct from timeout during delayed Windows cleanup', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { execCommand } = await import('../src/exec-command.js');
    const child = fixture();
    const controller = new AbortController();
    const pending = execCommand({
      command: 'fixture',
      args: [],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(8000);
    child.exitCode = 1;
    child.emit('close', 1);
    expect(await pending).toMatchObject({ timedOut: false, truncated: false, exitCode: 1 });
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('does not start a second tree kill when cancellation follows a buffer cutoff', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { execCommand } = await import('../src/exec-command.js');
    const child = fixture();
    const controller = new AbortController();
    const pending = execCommand({
      command: 'fixture',
      args: [],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 1000,
      maxBufferBytes: 1,
      signal: controller.signal,
    });
    child.stdout.write(Buffer.from('overflow'));
    controller.abort();
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
    child.exitCode = 1;
    child.emit('close', 1);
    expect(await pending).toMatchObject({ timedOut: false, truncated: true });
  });

  it('returns a normally completed command immediately', async () => {
    const { execCommand } = await import('../src/exec-command.js');
    const child = fixture();
    const pending = execCommand({
      command: 'fixture',
      args: [],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 100,
    });
    child.exitCode = 0;
    child.emit('close', 0);
    expect(await pending).toMatchObject({ timedOut: false, exitCode: 0 });
    expect(killTree).not.toHaveBeenCalled();
  });
});
