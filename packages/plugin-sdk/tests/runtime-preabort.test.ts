import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRunnerCommand } from '../src/runtime/index.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

afterEach(() => vi.clearAllMocks());

const options = { cwd: process.cwd(), projectRoot: process.cwd(), timeoutMs: 5000 };
const command = [process.execPath, '-e', 'process.stdout.write("control")'];

describe('runner cancellation before launch', () => {
  it('runs a real child with an active signal', async () => {
    const result = await runRunnerCommand(command, {
      ...options,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      code: 0,
      stdout: 'control',
      timedOut: false,
      spawnError: false,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('does not launch a child with an already-aborted signal', async () => {
    const result = await runRunnerCommand(command, { ...options, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ code: null, timedOut: true, spawnError: false });
    expect(execFile, 'FAIL: cancelled runner work must not launch a child').not.toHaveBeenCalled();
  });

  it('does not attempt a missing executable after cancellation', async () => {
    const result = await runRunnerCommand(['ws-no-such-binary-preabort'], {
      ...options,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ code: null, timedOut: true, spawnError: false });
    expect(
      execFile,
      'FAIL: cancellation must prevent even a failed spawn attempt',
    ).not.toHaveBeenCalled();
  });
});
