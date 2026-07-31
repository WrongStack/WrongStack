/**
 * Tests for TerminalServer.
 *
 * Uses `node` (resolved by spawn via $PATH) as the spawned command.
 * `node` is on every CI runner, and resolving by name sidesteps a
 * known Windows issue where some EDR / Defender policies block spawn
 * of binaries under `C:\Program Files\` even when the path is valid
 * and the process exists.
 *
 * The projectRoot directory is created in beforeEach because spawn
 * on Windows fails with ENOENT when the cwd doesn't exist (Linux is
 * more permissive).
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TerminalServer } from '../src/client/terminal-server.js';

let projectRoot: string;
let server: TerminalServer;

beforeEach(async () => {
  projectRoot = path.resolve(os.tmpdir(), 'wstack-term-' + Math.random().toString(36).slice(2));
  await fsp.mkdir(projectRoot, { recursive: true });
  server = new TerminalServer({ projectRoot, commandTimeoutMs: 10_000 });
});

afterEach(async () => {
  server.releaseAll();
  // Best-effort retry: on Windows the rmdir occasionally fails with
  // EBUSY when a child process still has the dir open for a moment.
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(projectRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('TerminalServer', () => {
  it('runs a command, captures output, returns exit code', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', "console.log('hello'); console.error('world')"],
    });
    expect(terminalId).toMatch(/^term_/);
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(0);
    const out = server.output(terminalId);
    expect(out.output).toContain('hello');
    expect(out.output).toContain('world');
  });

  it('returns a non-zero exit code for a failing command', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'process.exit(7)'],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(7);
  });

  it('caps retained output to outputByteLimit', async () => {
    // Override the per-call byte limit to 256 bytes.
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: [
        '-e',
        // Emit 1024 bytes of 'A' so the buffer must truncate.
        "process.stdout.write('A'.repeat(1024))",
      ],
      outputByteLimit: 256,
    });
    await server.waitForExit(terminalId);
    const out = server.output(terminalId);
    // The truncation is FIFO — we keep the LAST 256 bytes (all 'A's
    // here, so the retained slice is just the tail).
    expect(out.output.length).toBeLessThanOrEqual(256);
    expect(out.truncated).toBe(true);
  });

  it('truncates UTF-8 output on a character boundary', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', "process.stdout.write('🙂'.repeat(32))"],
      outputByteLimit: 18,
    });
    await server.waitForExit(terminalId);
    const out = server.output(terminalId);
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(18);
    expect(out.output).not.toContain('�');
    expect(out.truncated).toBe(true);
  });

  it('enforces a host-wide terminal count limit', () => {
    const limited = new TerminalServer({ projectRoot, maxTerminals: 1 });
    try {
      limited.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
      });
      expect(() =>
        limited.create({ sessionId: 's1', command: 'node', args: ['-e', 'process.exit(0)'] }),
      ).toThrow(/terminal limit reached/);
    } finally {
      limited.releaseAll();
    }
  });

  it('caps agent output limits at the host maximum', async () => {
    const cappedServer = new TerminalServer({
      projectRoot,
      commandTimeoutMs: 10_000,
      outputByteLimit: 128,
      maxOutputByteLimit: 64,
    });
    try {
      const { terminalId } = cappedServer.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', "process.stdout.write('A'.repeat(1024))"],
        outputByteLimit: 1024,
      });
      await cappedServer.waitForExit(terminalId);
      const out = cappedServer.output(terminalId);
      expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(64);
      expect(out.truncated).toBe(true);
    } finally {
      cappedServer.releaseAll();
    }
  });

  it('falls back to the configured output limit for non-finite values', async () => {
    const fallbackServer = new TerminalServer({
      projectRoot,
      commandTimeoutMs: 10_000,
      outputByteLimit: 32,
      maxOutputByteLimit: 64,
    });
    try {
      const { terminalId } = fallbackServer.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', "process.stdout.write('A'.repeat(1024))"],
        outputByteLimit: Number.POSITIVE_INFINITY,
      });
      await fallbackServer.waitForExit(terminalId);
      const out = fallbackServer.output(terminalId);
      expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(32);
      expect(out.truncated).toBe(true);
    } finally {
      fallbackServer.releaseAll();
    }
  });

  it('kill() terminates a long-running command', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 100));
    server.kill(terminalId);
    const exit = await server.waitForExit(terminalId);
    // exitCode is null when killed by signal on POSIX and 1 after taskkill on
    // Windows. Either outcome proves the child reached a terminal state.
    expect(exit.exitCode !== 0 || exit.signal !== null).toBe(true);
  });

  it('timeout kills a long-running command when commandTimeoutMs elapses', async () => {
    const fastTimeoutServer = new TerminalServer({ projectRoot, commandTimeoutMs: 20 });
    try {
      const { terminalId } = fastTimeoutServer.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'], // never exits on its own
      });
      const exit = await fastTimeoutServer.waitForExit(terminalId);
      // After the 20ms timeout, the process should be killed
      // On Windows, SIGTERM maps to TerminateProcess; exitCode is 1
      // On POSIX, signal is 'SIGTERM'
      expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    } finally {
      fastTimeoutServer.releaseAll();
    }
  });

  it('release() clears the timeout handle', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });
    await server.waitForExit(terminalId);
    server.release(terminalId);
    // After release, output() should throw
    expect(() => server.output(terminalId)).toThrow(/unknown terminal/);
  });

  it('release() detaches and destroys child output pipes', () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'setInterval(() => process.stdout.write("x"), 10)'],
    });
    const internal = server as unknown as {
      terminals: Map<
        string,
        {
          proc: { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream };
          outputChunks: Buffer[];
        }
      >;
    };
    const state = internal.terminals.get(terminalId)!;
    expect(state.proc.stdout?.listenerCount('data')).toBe(1);
    expect(state.proc.stderr?.listenerCount('data')).toBe(1);

    server.release(terminalId);

    expect(state.proc.stdout?.listenerCount('data')).toBe(0);
    expect(state.proc.stderr?.listenerCount('data')).toBe(0);
    expect(state.outputChunks).toHaveLength(0);
  });

  it('spawn error (ENOENT) yields exitCode 127', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(127);
  });

  it('output() throws for an unknown terminal', () => {
    expect(() => server.output('term_does_not_exist')).toThrow();
  });

  it('buildEnv merges agent-env vars into the child environment', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'console.log(process.env.MY_TEST_VAR)'],
      env: [{ name: 'MY_TEST_VAR', value: 'agent-env-value' }],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(0);
    const out = server.output(terminalId);
    expect(out.output.trim()).toBe('agent-env-value');
  });

  it('strips sensitive host credentials from the child environment', async () => {
    const previous = process.env['ACP_TERMINAL_SECRET_TOKEN'];
    process.env['ACP_TERMINAL_SECRET_TOKEN'] = 'must-not-leak';
    try {
      const { terminalId } = server.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', "console.log(process.env.ACP_TERMINAL_SECRET_TOKEN ?? 'missing')"],
      });
      const exit = await server.waitForExit(terminalId);
      expect(exit.exitCode).toBe(0);
      expect(server.output(terminalId).output.trim()).toBe('missing');
    } finally {
      if (previous === undefined) delete process.env['ACP_TERMINAL_SECRET_TOKEN'];
      else process.env['ACP_TERMINAL_SECRET_TOKEN'] = previous;
    }
  });

  it('rejects agent overrides that enable code injection or path hijacking', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({ node: process.env.NODE_OPTIONS, path: process.env.PATH, preload: process.env.LD_PRELOAD, dyld: process.env.DYLD_INSERT_LIBRARIES, allowed: process.env.MY_TEST_VAR }))',
      ],
      env: [
        { name: 'node_options', value: '--require definitely-not-a-real-module' },
        { name: 'Path', value: 'attacker-controlled-path' },
        { name: 'LD_PRELOAD', value: 'attacker-controlled-library' },
        { name: 'DYLD_INSERT_LIBRARIES', value: 'attacker-controlled-library' },
        { name: 'MY_TEST_VAR', value: 'allowed' },
      ],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(0);
    const env = JSON.parse(server.output(terminalId).output.trim()) as {
      node?: string;
      path?: string;
      preload?: string;
      dyld?: string;
      allowed?: string;
    };
    expect(env.node ?? '').not.toContain('definitely-not-a-real-module');
    expect(env.path).not.toBe('attacker-controlled-path');
    expect(env.preload).toBeUndefined();
    expect(env.dyld).toBeUndefined();
    expect(env.allowed).toBe('allowed');
  });

  it('resolveCwd uses projectRoot when the requested cwd is outside', async () => {
    const outsideCwd = path.resolve(os.tmpdir(), 'some-outside-dir-' + Date.now());
    await fsp.mkdir(outsideCwd, { recursive: true }).catch(() => {});
    try {
      const { terminalId } = server.create({
        sessionId: 's1',
        command: 'node',
        args: ['-e', 'console.log(process.cwd())'],
        cwd: outsideCwd,
      });
      await server.waitForExit(terminalId);
      const out = server.output(terminalId);
      // The cwd should be the projectRoot since outsideCwd is outside
      expect(out.output.trim()).toContain(projectRoot);
    } finally {
      await fsp.rm(outsideCwd, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('resolveCwd uses projectRoot when cwd resolves through an outside symlink', async () => {
    const outsideCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-term-outside-'));
    const linkedCwd = path.join(projectRoot, 'outside-link');
    try {
      await fsp.symlink(outsideCwd, linkedCwd, process.platform === 'win32' ? 'junction' : 'dir');
      const { terminalId } = server.create({
        sessionId: 's1',
        command: process.execPath,
        args: ['-e', 'console.log(process.cwd())'],
        cwd: linkedCwd,
      });
      await server.waitForExit(terminalId);
      expect(server.output(terminalId).output.trim()).toBe(await fsp.realpath(projectRoot));
    } finally {
      await fsp.rm(outsideCwd, { recursive: true, force: true });
    }
  });

  it('resolveCwd uses projectRoot when cwd is undefined', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'console.log(process.cwd())'],
      // no cwd provided
    });
    await server.waitForExit(terminalId);
    const out = server.output(terminalId);
    expect(out.output.trim()).toContain(projectRoot);
  });

  it('kill() throws for unknown terminal', () => {
    expect(() => server.kill('term_fake')).toThrow(/unknown terminal/);
  });

  it('waitForExit() throws for unknown terminal', async () => {
    await expect(server.waitForExit('term_fake')).rejects.toThrow(/unknown terminal/);
  });
});
