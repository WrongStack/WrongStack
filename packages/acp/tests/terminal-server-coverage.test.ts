import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStream extends EventEmitter {
  setEncoding = vi.fn();
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { TerminalServer } from '../src/client/terminal-server.js';

let proc: FakeProcess;

beforeEach(() => {
  vi.useFakeTimers();
  proc = new FakeProcess();
  mocks.spawn.mockReset();
  mocks.spawn.mockReturnValue(proc);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalServer deterministic edge coverage', () => {
  it('handles absent argv/env, pending output, abort cleanup, and numeric clamps', () => {
    const controller = new AbortController();
    const server = new TerminalServer({
      projectRoot: process.cwd(),
      signal: controller.signal,
      maxTerminals: 0,
    });
    const internal = server as unknown as {
      clampFiniteInt(value: number | undefined, fallback: number): number;
    };
    expect(internal.clampFiniteInt(undefined, 7)).toBe(7);
    expect(internal.clampFiniteInt(Number.NaN, 7)).toBe(7);
    expect(internal.clampFiniteInt(0, 7)).toBe(7);
    expect(internal.clampFiniteInt(3.9, 7)).toBe(3);

    const { terminalId } = server.create({ sessionId: 's', command: 'agent' });
    expect(server.output(terminalId)).toEqual({ output: '', truncated: false });
    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('bounds spawn errors and clears an active timeout', async () => {
    const server = new TerminalServer({
      projectRoot: process.cwd(),
      outputByteLimit: 2,
      commandTimeoutMs: 100,
    });
    const { terminalId } = server.create({ sessionId: 's', command: 'missing' });
    const internal = server as unknown as {
      terminals: Map<string, { timeoutHandle: ReturnType<typeof setTimeout> | null }>;
    };
    clearTimeout(internal.terminals.get(terminalId)!.timeoutHandle!);
    internal.terminals.get(terminalId)!.timeoutHandle = null;
    proc.emit('error', new Error('🙂'));
    await expect(server.waitForExit(terminalId)).resolves.toEqual({
      exitCode: 127,
      signal: null,
    });
    expect(server.output(terminalId)).toMatchObject({ truncated: true });
  });

  it('compacts many evicted chunks and tolerates timeout, kill, and release failures', () => {
    const server = new TerminalServer({
      projectRoot: process.cwd(),
      outputByteLimit: 1,
      commandTimeoutMs: 10,
    });
    const { terminalId } = server.create({ sessionId: 's', command: 'agent' });
    for (let i = 0; i < 300; i++) proc.stdout.emit('data', 'ab');
    expect(server.output(terminalId).output).toBe('b');

    proc.kill.mockImplementation(() => {
      throw new Error('already dead');
    });
    vi.advanceTimersByTime(10);
    expect(() => server.kill(terminalId)).not.toThrow();
    expect(() => server.release(terminalId)).not.toThrow();
    expect(() => server.release('missing')).not.toThrow();
  });

  it('resolves filesystem roots and falls back from missing working directories', () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    const server = new TerminalServer({ projectRoot: filesystemRoot });
    const internal = server as unknown as {
      resolveCwd(cwd: string | undefined): string;
    };
    expect(internal.resolveCwd(filesystemRoot)).toBe(filesystemRoot);
    expect(internal.resolveCwd(path.join(filesystemRoot, 'definitely-missing-cwd'))).toBe(
      filesystemRoot,
    );
  });
});
