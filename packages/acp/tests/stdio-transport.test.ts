import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ACPMessage } from '../src/types/acp-messages.js';

// ── spawn mock for ClientTransport ──────────────────────────────────────────
const spawnMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: (...a: unknown[]) => spawnMock.fn(...a) };
});

import {
  ClientTransport,
  StdioTransport,
  stdioTransportCoverage,
} from '../src/agent/stdio-transport.js';

// ── fakes ───────────────────────────────────────────────────────────────────
class FakeStdin extends EventEmitter {
  resume = vi.fn();
  pause = vi.fn();
  setEncoding = vi.fn();
}
class FakeWritable {
  written: string[] = [];
  failNext = false;
  write(data: string, _enc?: unknown, cb?: (err?: Error) => void): boolean {
    this.written.push(data);
    const callback = typeof _enc === 'function' ? (_enc as (e?: Error) => void) : cb;
    callback?.(this.failNext ? new Error('write failed') : undefined);
    return true;
  }
}

describe('StdioTransport', () => {
  let stdin: FakeStdin;
  let stdout: FakeWritable;
  let stderr: FakeWritable;
  const originals = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  beforeEach(() => {
    stdin = new FakeStdin();
    stdout = new FakeWritable();
    stderr = new FakeWritable();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originals.stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originals.stdout, configurable: true });
    Object.defineProperty(process, 'stderr', { value: originals.stderr, configurable: true });
  });

  it('constructor resumes stdin and sets utf8 encoding', () => {
    // eslint-disable-next-line no-new
    new StdioTransport();
    expect(stdin.resume).toHaveBeenCalled();
    expect(stdin.setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('sendStartupMarker writes the marker', () => {
    const t = new StdioTransport();
    t.sendStartupMarker();
    expect(stdout.written).toContain('[wstack-acp]\n');
  });

  it('send writes JSON + newline and resolves', async () => {
    const t = new StdioTransport();
    await t.send({ method: 'x', id: 1 });
    expect(stdout.written).toEqual([JSON.stringify({ method: 'x', id: 1 }) + '\n']);
  });

  it('send after close resolves without writing', async () => {
    const t = new StdioTransport();
    t.close();
    await t.send({ method: 'x' });
    expect(stdout.written).toEqual([]);
  });

  it('sendRaw writes the chunk verbatim', () => {
    const t = new StdioTransport();
    t.sendRaw('raw-bytes');
    expect(stdout.written).toContain('raw-bytes');
  });

  it('read resolves a pending promise when a message arrives', async () => {
    const t = new StdioTransport();
    const p = t.read();
    stdin.emit('data', JSON.stringify({ method: 'a', id: 1 }) + '\n');
    expect(await p).toEqual({ method: 'a', id: 1 });
  });

  it('read returns a previously queued message synchronously', async () => {
    const t = new StdioTransport();
    stdin.emit('data', JSON.stringify({ method: 'queued' }) + '\n');
    expect(await t.read()).toEqual({ method: 'queued' });
  });

  it('read returns null after close', async () => {
    const t = new StdioTransport();
    t.close();
    expect(await t.read()).toBeNull();
  });

  it('buffers partial lines across data events', async () => {
    const t = new StdioTransport();
    const p = t.read();
    stdin.emit('data', '{"method":"split"');
    stdin.emit('data', ',"id":7}\n');
    expect(await p).toEqual({ method: 'split', id: 7 });
  });

  it('closes instead of retaining an oversized pending frame', async () => {
    const t = new StdioTransport({ maxFrameChars: 8 });
    stdin.emit('data', '123456789');
    expect(stdin.pause).toHaveBeenCalled();
    expect(await t.read()).toBeNull();
    expect(stderr.written.some((s) => s.includes('frame error'))).toBe(true);
  });

  it('accepts a large chunk made of individually bounded frames', async () => {
    const t = new StdioTransport({ maxFrameChars: 15 });
    stdin.emit('data', '{"method":"a"}\n{"method":"b"}\n');
    expect(await t.read()).toEqual({ method: 'a' });
    expect(await t.read()).toEqual({ method: 'b' });
    expect(stdin.pause).not.toHaveBeenCalled();
  });

  it('closes on an oversized complete frame and a full message queue', async () => {
    const oversized = new StdioTransport({ maxFrameChars: 8 });
    stdin.emit('data', '{"method":"too-long"}\n');
    expect(await oversized.read()).toBeNull();

    stdin = new FakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const queued = new StdioTransport({ maxQueuedMessages: 1 });
    stdin.emit('data', '{"id":1}\n{"id":2}\n');
    expect(await queued.read()).toBeNull();
    expect(stderr.written.some((entry) => entry.includes('queue error'))).toBe(true);
  });

  it('writes a parse error to stderr for malformed JSON', () => {
    const t = new StdioTransport();
    void t;
    stdin.emit('data', 'not-json\n');
    expect(stderr.written.some((s) => s.includes('parse error'))).toBe(true);
  });

  it('skips blank lines', async () => {
    const t = new StdioTransport();
    const p = t.read();
    stdin.emit('data', '\n   \n' + JSON.stringify({ method: 'real' }) + '\n');
    expect(await p).toEqual({ method: 'real' });
  });

  it('onMessage delivers to handlers and unsubscribe stops delivery', () => {
    const t = new StdioTransport();
    const seen: ACPMessage[] = [];
    const off = t.onMessage((m) => seen.push(m));
    stdin.emit('data', JSON.stringify({ method: 'one' }) + '\n');
    off();
    stdin.emit('data', JSON.stringify({ method: 'two' }) + '\n');
    expect(seen).toEqual([{ method: 'one' }]);
  });

  it('isolates a throwing handler and logs to stderr', () => {
    const t = new StdioTransport();
    t.onMessage(() => {
      throw new Error('handler boom');
    });
    expect(() => stdin.emit('data', JSON.stringify({ method: 'x' }) + '\n')).not.toThrow();
    expect(stderr.written.some((s) => s.includes('handler error'))).toBe(true);
  });

  it('close resolves an outstanding read with null', async () => {
    const t = new StdioTransport();
    const p = t.read();
    t.close();
    expect(await p).toBeNull();
  });

  it('stdin "end" closes the transport (EOF → read null)', async () => {
    const t = new StdioTransport();
    const p = t.read();
    stdin.emit('end');
    expect(await p).toBeNull();
  });

  it('stdin "error" logs and closes', async () => {
    const t = new StdioTransport();
    const p = t.read();
    stdin.emit('error', new Error('pipe broke'));
    expect(await p).toBeNull();
    expect(stderr.written.some((s) => s.includes('stdin error'))).toBe(true);
  });
});

// ── ClientTransport ──────────────────────────────────────────────────────────
class FakeChildStream extends EventEmitter {
  setEncoding = vi.fn();
  written: string[] = [];
  failNext = false;
  write(data: string, _enc?: unknown, cb?: (err?: Error) => void): boolean {
    this.written.push(data);
    const callback = typeof _enc === 'function' ? (_enc as (e?: Error) => void) : cb;
    callback?.(this.failNext ? new Error('stdin write failed') : undefined);
    return true;
  }
}
class FakeChild extends EventEmitter {
  stdout = new FakeChildStream();
  stdin = new FakeChildStream();
  stderr = new FakeChildStream();
  pid = 4321;
  kill = vi.fn();
}

async function startedTransport(): Promise<{ transport: ClientTransport; child: FakeChild }> {
  const child = new FakeChild();
  spawnMock.fn.mockReturnValue(child);
  const transport = new ClientTransport({
    command: 'agent',
    args: ['--x'],
    env: { K: 'v' },
    cwd: '/w',
  });
  const p = transport.start();
  await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
  child.stdout.emit('data', '[wstack-acp]\n');
  await p;
  return { transport, child };
}

describe('ClientTransport', () => {
  beforeEach(() => spawnMock.fn.mockReset());

  it('start spawns the child with merged env, cwd and windowsHide, resolving on the marker', async () => {
    const { child } = await startedTransport();
    expect(spawnMock.fn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.fn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    if (process.platform === 'win32') {
      expect(cmd.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(args).toEqual(['/d', '/c', 'call "agent" "--x"']);
      expect(opts.windowsVerbatimArguments).toBe(true);
    } else {
      expect(cmd).toBe('agent');
      expect(args).toEqual(['--x']);
      expect(opts.windowsVerbatimArguments).toBeUndefined();
    }
    expect(opts.cwd).toBe('/w');
    expect(opts.windowsHide).toBe(true);
    expect((opts.env as Record<string, string>).K).toBe('v');
    expect(child.stdout.setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('waits across chunks when the marker is not in the first data event', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'agent' });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.stdout.emit('data', 'preamble without marker');
    child.stdout.emit('data', '[wstack-acp]\n');
    await expect(p).resolves.toBeUndefined();
  });

  it('start is idempotent once a child exists', async () => {
    const { transport } = await startedTransport();
    await transport.start(); // should return immediately, no second spawn
    expect(spawnMock.fn).toHaveBeenCalledTimes(1);
  });

  it('start rejects when the child stdout emits an error before the marker', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'agent' });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.stdout.emit('error', new Error('stdout broke'));
    await expect(p).rejects.toThrow('stdout broke');
    child.stdout.emit('data', '[wstack-acp]\n');
  });

  it('start rejects when the child emits an error before the marker', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'agent' });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('error', new Error('spawn died'));
    await expect(p).rejects.toThrow('spawn died');
  });

  it('skip-marker: resolves on the child "spawn" event (no startup marker)', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'agent', skipHandshakeMarker: true });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('spawn');
    await expect(p).resolves.toBeUndefined();
    child.stdout.emit('data', '{"id":1}\n');
    child.stderr.emit('data', 'log');
    child.emit('close', null);
  });

  it('skip-marker: rejects on a spawn error instead of crashing with an unhandled "error"', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'missing-bin', skipHandshakeMarker: true });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    // An ENOENT-style failure: the child emits 'error' before 'spawn'. The
    // error listener must already be attached (regression: it previously was
    // registered AFTER the skip-marker early-return, so this crashed).
    const err = Object.assign(new Error('spawn missing-bin ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    await expect(p).rejects.toThrow('ENOENT');
    child.emit('spawn');
  });

  it('spawns npx/uvx package launchers from a neutral home dir (avoids repo dep-override EOVERRIDE)', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({
      command: 'npx',
      args: ['-y', '@x/y'],
      cwd: '/repo/with/overrides',
      skipHandshakeMarker: true,
    });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('spawn');
    await p;
    const spawnOpts = spawnMock.fn.mock.calls[0]![2] as { cwd?: string };
    expect(spawnOpts.cwd).toBe(os.homedir());
  });

  it('spawns local binaries from the requested cwd (only npx/uvx get redirected)', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({
      command: 'gemini',
      args: ['--acp'],
      cwd: '/repo/project',
      skipHandshakeMarker: true,
    });
    const p = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('spawn');
    await p;
    const spawnOpts = spawnMock.fn.mock.calls[0]![2] as { cwd?: string };
    expect(spawnOpts.cwd).toBe('/repo/project');
  });

  it('child error after settlement (post-ready) marks transport closed without rejecting', async () => {
    const { transport, child } = await startedTransport();
    // After the transport has started successfully, an error on the child
    // process should only mark closed (post-settled path, line 236-237)
    child.emit('error', new Error('post-settle crash'));
    // No rejection; the transport is just marked closed
    expect(await transport.read()).toBeNull();
  });

  it('start rejects on handshake timeout when no marker arrives', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({ command: 'agent', handshakeTimeoutMs: 30 });
    await expect(transport.start()).rejects.toThrow(/failed to start within 30ms/);
  });

  it('send before start rejects', async () => {
    const transport = new ClientTransport({ command: 'agent' });
    await expect(transport.send({ method: 'x' })).rejects.toThrow('not started');
  });

  it('send writes a JSON line to child stdin', async () => {
    const { transport, child } = await startedTransport();
    await transport.send({ method: 'go', id: 1 });
    expect(child.stdin.written).toContain(JSON.stringify({ method: 'go', id: 1 }) + '\n');
  });

  it('send rejects when the stdin write errors', async () => {
    const { transport, child } = await startedTransport();
    child.stdin.failNext = true;
    await expect(transport.send({ method: 'bad' })).rejects.toThrow('stdin write failed');
  });

  it('dispatches child stdout messages to read() and onMessage', async () => {
    const { transport, child } = await startedTransport();
    const seen: ACPMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    const p = transport.read();
    child.stdout.emit('data', JSON.stringify({ method: 'reply', id: 9 }) + '\n');
    expect(await p).toEqual({ method: 'reply', id: 9 });
    expect(seen).toEqual([{ method: 'reply', id: 9 }]);
  });

  it('onMessage unsubscribe stops delivery', async () => {
    const { transport, child } = await startedTransport();
    const seen: ACPMessage[] = [];
    const off = transport.onMessage((m) => seen.push(m));
    child.stdout.emit('data', JSON.stringify({ method: 'first' }) + '\n');
    off();
    child.stdout.emit('data', JSON.stringify({ method: 'second' }) + '\n');
    expect(seen).toEqual([{ method: 'first' }]);
  });

  it('does not duplicate onMessage traffic into the optional read queue', async () => {
    const { transport, child } = await startedTransport();
    const seen: ACPMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    child.stdout.emit('data', JSON.stringify({ method: 'handler-only' }) + '\n');
    expect(seen).toEqual([{ method: 'handler-only' }]);
    expect((transport as unknown as { messageQueue: ACPMessage[] }).messageQueue).toHaveLength(0);
  });

  it('kills the child instead of retaining an oversized pending frame', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({
      command: 'agent',
      skipHandshakeMarker: true,
      maxFrameChars: 8,
    });
    const started = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('spawn');
    await started;
    child.stdout.emit('data', '123456789');
    expect(child.kill).toHaveBeenCalled();
    expect(await transport.read()).toBeNull();
  });

  it('accepts a large child chunk made of individually bounded frames', async () => {
    const child = new FakeChild();
    spawnMock.fn.mockReturnValue(child);
    const transport = new ClientTransport({
      command: 'agent',
      skipHandshakeMarker: true,
      maxFrameChars: 15,
    });
    const started = transport.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    child.emit('spawn');
    await started;
    child.stdout.emit('data', '{"method":"a"}\n{"method":"b"}\n');
    expect(await transport.read()).toEqual({ method: 'a' });
    expect(await transport.read()).toEqual({ method: 'b' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('stops on an oversized complete child frame and a full child queue', async () => {
    const complete = new FakeChild();
    spawnMock.fn.mockReturnValueOnce(complete);
    const oversized = new ClientTransport({
      command: 'agent',
      skipHandshakeMarker: true,
      maxFrameChars: 8,
    });
    const started = oversized.start();
    await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
    complete.emit('spawn');
    await started;
    complete.stdout.emit('data', '{"method":"too-long"}\n');
    expect(complete.kill).toHaveBeenCalled();

    const full = new FakeChild();
    const queued = new ClientTransport({
      command: 'agent',
      skipHandshakeMarker: true,
      maxQueuedMessages: 1,
    });
    const internal = queued as unknown as {
      child: FakeChild;
      dispatch(message: ACPMessage): void;
    };
    internal.child = full;
    internal.dispatch({ id: 1, method: 'queue.test' });
    internal.dispatch({ id: 2, method: 'queue.test' });
    expect(full.kill).toHaveBeenCalled();
  });

  it('queues child messages with no pending read', async () => {
    const { transport, child } = await startedTransport();
    child.stdout.emit('data', JSON.stringify({ method: 'q' }) + '\n');
    expect(await transport.read()).toEqual({ method: 'q' });
  });

  it('skips blank lines in child stdout', async () => {
    const { transport, child } = await startedTransport();
    child.stdout.emit('data', '\n  \n' + JSON.stringify({ method: 'real' }) + '\n');
    expect(await transport.read()).toEqual({ method: 'real' });
  });

  it('skips malformed child stdout lines silently', async () => {
    const { transport, child } = await startedTransport();
    const seen: ACPMessage[] = [];
    transport.onMessage((m) => seen.push(m));
    child.stdout.emit('data', 'garbage{\n' + JSON.stringify({ method: 'ok' }) + '\n');
    expect(seen).toEqual([{ method: 'ok' }]);
  });

  it('isolates a throwing onMessage handler', async () => {
    const { transport, child } = await startedTransport();
    transport.onMessage(() => {
      throw new Error('boom');
    });
    expect(() => child.stdout.emit('data', JSON.stringify({ method: 'x' }) + '\n')).not.toThrow();
  });

  it('child stderr data does not throw', async () => {
    const { child } = await startedTransport();
    expect(() => child.stderr.emit('data', 'some log line')).not.toThrow();
  });

  it('child close with non-zero code closes the transport', async () => {
    const { transport, child } = await startedTransport();
    child.emit('close', 1);
    expect(await transport.read()).toBeNull();
  });

  it('child close with code 0 closes cleanly', async () => {
    const { transport, child } = await startedTransport();
    child.emit('close', 0);
    expect(await transport.read()).toBeNull();
  });

  it('stop kills the child', async () => {
    const { transport, child } = await startedTransport();
    transport.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('stop before start is a no-op', () => {
    const transport = new ClientTransport({ command: 'agent' });
    expect(() => transport.stop()).not.toThrow();
  });

  it('stop swallows a throwing kill', async () => {
    const { transport, child } = await startedTransport();
    child.kill.mockImplementation(() => {
      throw new Error('already dead');
    });
    expect(() => transport.stop()).not.toThrow();
  });

  it('normalizes limits and platform-specific spawn invocations', () => {
    expect(stdioTransportCoverage.positiveLimit(undefined, 10)).toBe(10);
    expect(stdioTransportCoverage.positiveLimit(Number.NaN, 10)).toBe(10);
    expect(stdioTransportCoverage.positiveLimit(-1, 10)).toBe(10);
    expect(stdioTransportCoverage.positiveLimit(3.9, 10)).toBe(3);
    expect(stdioTransportCoverage.spawnInvocation('agent', ['--x'], 'linux')).toEqual({
      command: 'agent',
      args: ['--x'],
    });
    expect(stdioTransportCoverage.spawnInvocation('agent', ['--x'], 'win32')).toMatchObject({
      args: ['/d', '/c', 'call "agent" "--x"'],
      windowsVerbatimArguments: true,
    });
    expect(stdioTransportCoverage.verbatimOptions({})).toEqual({});
    expect(stdioTransportCoverage.verbatimOptions({ windowsVerbatimArguments: true })).toEqual({
      windowsVerbatimArguments: true,
    });
  });
});
