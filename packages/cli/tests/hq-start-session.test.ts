/**
 * HQ `start-session`: a connected client opens a new headless session in its
 * project. The launcher only ever runs this wstack with the prompt as ONE
 * argv entry (no shell), the client must have opted in to remote execution,
 * and the server gates the command exactly like `run-command` — plus the
 * target has to advertise `session.start`.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import type { HqCommand } from '@wrongstack/hq';
import {
  HQ_AUTH_FILE_VERSION,
  HQ_PROTOCOL_VERSION,
  hashHqPassword,
  mintHqCookieSecret,
  writeHqAuthFile,
} from '@wrongstack/hq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import {
  createHqCommandDispatcher,
  type HqCommandController,
} from '../src/hq-command-controller.js';
import { authorizeHqCommand } from '../src/hq-server/trust-boundary.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { createHqSessionLauncher } from '../src/hq-session-launcher.js';
import { WebSocket } from '../src/ws-runtime.js';

// ── Launcher ────────────────────────────────────────────────────────────────

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
  child: EventEmitter & { pid: number; unref: () => void };
}

function fakeSpawn(calls: SpawnCall[]) {
  return (command: string, args: readonly string[], options: unknown) => {
    const child = Object.assign(new EventEmitter(), { pid: 4000 + calls.length, unref: vi.fn() });
    calls.push({ command, args, options: options as Record<string, unknown>, child });
    return child as never;
  };
}

describe('HQ session launcher', () => {
  it('launches this wstack with the prompt as one argument, never through a shell', () => {
    const calls: SpawnCall[] = [];
    const prompt = '--yolo-plus; rm -rf ~ && echo "$HOME" `id`';
    const launcher = createHqSessionLauncher({
      projectRoot: () => '/srv/datapipe',
      spawnImpl: fakeSpawn(calls),
      execPath: '/usr/bin/bun',
      entry: '/opt/wstack/packages/cli/dist/index.js',
      standalone: false,
      platform: 'linux',
    });
    expect(launcher.start(prompt)).toEqual({ pid: 4000 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe('/usr/bin/bun');
    expect(call?.args).toEqual([
      '/opt/wstack/packages/cli/dist/index.js',
      '--hq-approver',
      `--prompt=${prompt}`,
    ]);
    expect(call?.options).toMatchObject({
      cwd: '/srv/datapipe',
      shell: false,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    expect(call?.child.unref).toHaveBeenCalled();
  });

  it('passes the prompt through the parser as data, even when it looks like flags', () => {
    const prompt = '--yolo-plus --provider evil';
    const calls: SpawnCall[] = [];
    createHqSessionLauncher({
      projectRoot: () => '/srv',
      spawnImpl: fakeSpawn(calls),
      standalone: true,
    }).start(prompt);
    const { flags, positional } = parseArgs([...(calls[0]?.args ?? [])]);
    expect(flags['prompt']).toBe(prompt);
    expect(flags['hq-approver']).toBe(true);
    expect(flags['yolo-plus']).toBeUndefined();
    expect(flags['provider']).toBeUndefined();
    expect(positional).toEqual([]);
  });

  it('the compiled binary gets only the flags, and Windows is not detached', () => {
    const calls: SpawnCall[] = [];
    createHqSessionLauncher({
      projectRoot: () => 'D:/dev/datapipe',
      spawnImpl: fakeSpawn(calls),
      execPath: 'C:/tools/wstack.exe',
      entry: 'B:/~BUN/root/wstack',
      standalone: true,
      platform: 'win32',
    }).start('go');
    expect(calls[0]?.command).toBe('C:/tools/wstack.exe');
    expect(calls[0]?.args).toEqual(['--hq-approver', '--prompt=go']);
    expect(calls[0]?.options).toMatchObject({ detached: false, windowsHide: true, shell: false });
  });

  it('refuses rather than falling back to a PATH lookup (a Windows .cmd shim is a shell)', () => {
    const calls: SpawnCall[] = [];
    const launcher = createHqSessionLauncher({
      projectRoot: () => '/srv',
      spawnImpl: fakeSpawn(calls),
      // A bare command name is a PATH lookup, never used.
      entry: 'wstack',
      standalone: false,
    });
    expect(() => launcher.start('go')).toThrow(/cannot locate its own wstack entry/);
    expect(calls).toHaveLength(0);
  });

  it('runs at most the limit at once and frees a slot when one exits', () => {
    const calls: SpawnCall[] = [];
    const launcher = createHqSessionLauncher({
      projectRoot: () => '/srv',
      spawnImpl: fakeSpawn(calls),
      entry: '/x/index.js',
      standalone: false,
      limit: 2,
    });
    launcher.start('a');
    launcher.start('b');
    expect(() => launcher.start('c')).toThrow(/limit 2/);
    expect(launcher.running()).toBe(2);
    calls[0]?.child.emit('exit', 0);
    expect(launcher.running()).toBe(1);
    expect(launcher.start('c').pid).toBe(4002);
  });
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

function controller(overrides: Partial<HqCommandController> = {}): HqCommandController {
  return {
    interruptLeader: () => false,
    sessionTag: () => 'tag',
    allowRunCommand: () => true,
    ...overrides,
  };
}

const startCommand = { commandId: 'c1', type: 'start-session', payload: { prompt: 'go' } };

describe('start-session dispatch', () => {
  it('is refused without the operator opt-in, and the launcher is never called', async () => {
    const startSession = vi.fn(() => ({ pid: 1 }));
    const result = await createHqCommandDispatcher(
      controller({ allowRunCommand: () => false, startSession }),
    )(startCommand);
    expect(result).toMatchObject({
      status: 'rejected',
      message: expect.stringMatching(/hq-allow-exec/),
    });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('re-validates the payload itself and trims the prompt before launching', async () => {
    const startSession = vi.fn(() => ({ pid: 5 }));
    const dispatch = createHqCommandDispatcher(controller({ startSession }));
    for (const payload of [{}, { prompt: '   ' }, { prompt: 'a\u0000b' }, { prompt: 42 }]) {
      const result = await dispatch({ commandId: 'c', type: 'start-session', payload });
      expect(result.status).toBe('rejected');
    }
    expect(startSession).not.toHaveBeenCalled();
    await dispatch({ commandId: 'c', type: 'start-session', payload: { prompt: '  go  ' } });
    expect(startSession).toHaveBeenCalledWith('go');
  });

  it('is refused by a client that has no launcher', async () => {
    const result = await createHqCommandDispatcher(controller())(startCommand);
    expect(result).toMatchObject({
      status: 'rejected',
      message: 'this client cannot start sessions',
    });
  });

  it('completes with the pid, or fails with the launcher reason', async () => {
    const ok = await createHqCommandDispatcher(controller({ startSession: () => ({ pid: 77 }) }))(
      startCommand,
    );
    expect(ok).toMatchObject({ status: 'completed', message: 'session started (pid 77)' });
    const full = await createHqCommandDispatcher(
      controller({
        startSession: () => {
          throw new Error('4 sessions started from HQ are still running (limit 4)');
        },
      }),
    )(startCommand);
    expect(full).toMatchObject({ status: 'failed', message: expect.stringMatching(/limit 4/) });
  });
});

// ── Trust boundary ──────────────────────────────────────────────────────────

describe('start-session at the trust boundary', () => {
  const command = { type: 'start-session', prompt: 'go' } as HqCommand;
  const authorize = async (authMethod: 'session' | 'bearer-token') => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return await authorizeHqCommand({
        boundary: createCompatibilityTrustBoundary(),
        command,
        commandId: 'cmd',
        enqueuedBy: 'operator',
        authMethod,
        target: { clientId: 'c1', projectId: 'p1', kind: 'tui' } as never,
      });
    } finally {
      warn.mockRestore();
    }
  };

  it('is critical: a bearer-token script is refused, the dashboard session is allowed', async () => {
    const bearer = await authorize('bearer-token');
    expect(bearer.allowed).toBe(false);
    expect(bearer.reason).toMatch(/remote-client/);
    expect((await authorize('session')).allowed).toBe(true);
  });
});

// ── Server ──────────────────────────────────────────────────────────────────

const PASSWORD = 'start-session-password';
const CLIENT_EXEC = 'client-with-exec-token';
const CLIENT_NO_EXEC = 'client-no-exec-token';
let handle: HqServerHandle | null = null;
let dataDir = '';
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (handle) {
    await handle.close();
    handle = null;
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  dataDir = '';
});

async function startServer(): Promise<HqServerHandle> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-start-session-'));
  const now = new Date().toISOString();
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: now,
    browserTokens: [{ id: 'bt', token: 'browser-token', createdAt: now }],
    clientTokens: [
      {
        id: 'ct-exec',
        token: CLIENT_EXEC,
        createdAt: now,
        capabilities: ['telemetry.publish', 'control.execute'],
      },
      {
        id: 'ct-no-exec',
        token: CLIENT_NO_EXEC,
        createdAt: now,
        capabilities: ['telemetry.publish'],
      },
    ],
    passwordHash: await hashHqPassword(PASSWORD),
    cookieSecret: mintHqCookieSecret(),
  });
  handle = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  return handle;
}

async function connectClient(
  server: HqServerHandle,
  token: string,
  clientId: string,
  capabilities: string[],
  startsSessions = false,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?token=${token}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const welcomed = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      if (raw.toString().includes('"hq.welcome"')) resolve();
    });
  });
  ws.send(
    JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: { clientId, kind: 'tui', machineId: 'lab', startedAt: new Date().toISOString() },
        project: {
          projectId: 'proj',
          projectRoot: '/srv/proj',
          projectName: 'proj',
          machineId: 'lab',
          workspaceKind: 'git',
        },
        capabilities,
        ...(startsSessions ? { startsSessions: true } : {}),
      },
    }),
  );
  await welcomed;
  return ws;
}

async function login(server: HqServerHandle): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}

function post(server: HqServerHandle, cookie: string, clientId: string, payload: unknown) {
  return fetch(`http://127.0.0.1:${server.port}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ clientId, type: 'start-session', payload }),
  });
}

const CAPS = ['telemetry.publish', 'control.receive'];

describe('HQ server start-session gates', () => {
  it('turns the hello field into the session.start capability on the snapshot', async () => {
    const server = await startServer();
    await connectClient(server, CLIENT_EXEC, 'exec-client', CAPS, true);
    await connectClient(server, CLIENT_EXEC, 'plain-client', CAPS);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`, {
      headers: { Cookie: await login(server) },
    });
    const snapshot = (await res.json()) as {
      clients: Array<{ clientId: string; capabilities: string[] }>;
    };
    const caps = (id: string) => snapshot.clients.find((c) => c.clientId === id)?.capabilities;
    expect(caps('exec-client')).toContain('session.start');
    expect(caps('plain-client')).not.toContain('session.start');
  });

  it('queues it for a capable client and delivers the trimmed prompt', async () => {
    const server = await startServer();
    const client = await connectClient(server, CLIENT_EXEC, 'exec-client', CAPS, true);
    const cookie = await login(server);
    const delivered = new Promise<Record<string, unknown>>((resolve) => {
      client.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          type: string;
          commands?: Array<Record<string, unknown>>;
        };
        const command = message.commands?.find((entry) => entry['type'] === 'start-session');
        if (command) resolve(command);
      });
    });
    const res = await post(server, cookie, 'exec-client', { prompt: '  write the notes  ' });
    expect(res.status).toBe(202);
    client.send(
      JSON.stringify({ type: 'client.command_poll', clientId: 'exec-client', projectId: 'proj' }),
    );
    // Forwarded as sent; the client re-validates and trims before launching.
    expect(await delivered).toMatchObject({
      type: 'start-session',
      payload: { prompt: '  write the notes  ' },
    });
  });

  it('answers 409 when the client does not advertise session.start', async () => {
    const server = await startServer();
    // An older client: no `startsSessions` in its hello.
    await connectClient(server, CLIENT_EXEC, 'old-client', CAPS);
    const res = await post(server, await login(server), 'old-client', { prompt: 'go' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('cannot start sessions');
  });

  it('answers 403 when the target token lacks control.execute', async () => {
    const server = await startServer();
    await connectClient(server, CLIENT_NO_EXEC, 'no-exec-client', CAPS, true);
    const res = await post(server, await login(server), 'no-exec-client', { prompt: 'go' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('control.execute');
  });

  it('answers 400 for an empty prompt', async () => {
    const server = await startServer();
    await connectClient(server, CLIENT_EXEC, 'exec-client', CAPS, true);
    const res = await post(server, await login(server), 'exec-client', { prompt: '   ' });
    expect(res.status).toBe(400);
  });

  it('refuses a bearer-token caller at the trust boundary', async () => {
    const server = await startServer();
    await connectClient(server, CLIENT_EXEC, 'exec-client', CAPS, true);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-token' },
      body: JSON.stringify({
        clientId: 'exec-client',
        type: 'start-session',
        payload: { prompt: 'go' },
      }),
    });
    expect(res.status).not.toBe(202);
    expect(await res.text()).toMatch(/remote-client/);
  });
});
