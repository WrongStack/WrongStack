import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqSocketLike } from '@wrongstack/core/hq';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile, writeHqRuntimeFile } from '@wrongstack/core/hq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCliHqConnection } from '../src/hq-publisher.js';

let dataDir: string | undefined;
const oldDataDir = process.env['WRONGSTACK_HQ_DATA_DIR'];
const oldEnabled = process.env['WRONGSTACK_HQ_ENABLED'];
const oldUrl = process.env['WRONGSTACK_HQ_URL'];
const oldToken = process.env['WRONGSTACK_HQ_TOKEN'];

afterEach(async () => {
  if (oldDataDir === undefined) delete process.env['WRONGSTACK_HQ_DATA_DIR'];
  else process.env['WRONGSTACK_HQ_DATA_DIR'] = oldDataDir;
  if (oldEnabled === undefined) delete process.env['WRONGSTACK_HQ_ENABLED'];
  else process.env['WRONGSTACK_HQ_ENABLED'] = oldEnabled;
  if (oldUrl === undefined) delete process.env['WRONGSTACK_HQ_URL'];
  else process.env['WRONGSTACK_HQ_URL'] = oldUrl;
  if (oldToken === undefined) delete process.env['WRONGSTACK_HQ_TOKEN'];
  else process.env['WRONGSTACK_HQ_TOKEN'] = oldToken;

  if (dataDir !== undefined) {
    await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  vi.useRealTimers();
});

class FakeSocket implements HqSocketLike {
  readyState = 1;
  sent: string[] = [];
  close = vi.fn();
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(
    _type: 'open' | 'close' | 'error' | 'message',
    _listener: (event: unknown) => void,
  ): void {
    // Already open.
  }
  removeEventListener(
    _type: 'open' | 'close' | 'error' | 'message',
    _listener: (event: unknown) => void,
  ): void {
    // no-op
  }
}

describe('CLI HQ publisher connection', () => {
  it('uses the same alias-backed project id for independent roots', () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const base = {
      clientKind: 'cli' as const,
      config: {
        enabled: true,
        url: 'http://127.0.0.1:3499',
        projectAlias: 'shared-project',
      },
      retryIntervalMs: 60_000,
    };
    const a = startCliHqConnection({
      ...base,
      projectRoot: '/copy/a',
      socketFactory: () => socketA,
    });
    const b = startCliHqConnection({
      ...base,
      projectRoot: '/copy/b',
      socketFactory: () => socketB,
    });
    expect(a.getPublisher()?.project.projectId).toBe(b.getPublisher()?.project.projectId);
    a.stop();
    b.stop();
  });
  it('connects later when the HQ runtime marker appears', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-hq-late-'));
    process.env['WRONGSTACK_HQ_DATA_DIR'] = dataDir;
    delete process.env['WRONGSTACK_HQ_ENABLED'];
    delete process.env['WRONGSTACK_HQ_URL'];
    delete process.env['WRONGSTACK_HQ_TOKEN'];

    let socket: FakeSocket | undefined;
    const onConnect = vi.fn();
    const conn = startCliHqConnection({
      clientKind: 'tui',
      projectRoot: dataDir,
      projectName: 'Late HQ',
      retryIntervalMs: 20,
      discoveryPollMs: 20,
      socketFactory: () => {
        socket = new FakeSocket();
        return socket;
      },
      onConnect,
    });

    // Auto-discovery: a dormant publisher exists immediately, but with no
    // runtime marker on disk it must not have dialed a socket yet.
    expect(conn.getPublisher()).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(socket).toBeUndefined();

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    await writeHqRuntimeFile(dataDir, { url: 'http://127.0.0.1:45678', pid: process.pid });

    await vi.waitFor(() => {
      expect(conn.getPublisher()).toBeDefined();
      expect(socket?.sent.some((frame) => frame.includes('client.hello'))).toBe(true);
    });

    conn.stop();
  });

  it('reconnects when a later runtime marker points at a different HQ port', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-hq-repoint-'));
    process.env['WRONGSTACK_HQ_DATA_DIR'] = dataDir;
    delete process.env['WRONGSTACK_HQ_ENABLED'];
    delete process.env['WRONGSTACK_HQ_URL'];
    delete process.env['WRONGSTACK_HQ_TOKEN'];

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [{ id: 'ct', token: 'client-token', createdAt: new Date().toISOString() }],
    });

    await writeHqRuntimeFile(dataDir, { url: 'http://127.0.0.1:45678', pid: process.pid });

    const urls: string[] = [];
    const onConnect = vi.fn();
    const conn = startCliHqConnection({
      clientKind: 'tui',
      projectRoot: dataDir,
      projectName: 'Repoint HQ',
      retryIntervalMs: 20,
      discoveryPollMs: 20,
      socketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
      onConnect,
    });

    expect(conn.getPublisher()).toBeDefined();
    await vi.waitFor(() => {
      expect(urls.some((url) => url.includes('127.0.0.1:45678'))).toBe(true);
    });

    // HQ restarts on a different port — the marker repoints, the client follows.
    const before = conn.getPublisher();
    await writeHqRuntimeFile(dataDir, { url: 'http://127.0.0.1:45679', pid: process.pid });

    await vi.waitFor(() => {
      expect(urls.some((url) => url.includes('127.0.0.1:45679'))).toBe(true);
    });

    // Following the marker must not REBUILD the publisher: a new instance
    // mints a new clientId, so one process shows up in HQ as a fresh client
    // plus a ghost of the old one, and the bounded outbound queue is dropped.
    expect(conn.getPublisher()).toBe(before);

    conn.stop();
  });

  it('keeps one publisher when the client token is minted after startup', async () => {
    // First run: HQ writes auth.json only once it boots, so the token the
    // discovery path resolves goes from absent to present under a live
    // publisher. Keying the connection on the resolved token rebuilt it here.
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-hq-late-token-'));
    process.env['WRONGSTACK_HQ_DATA_DIR'] = dataDir;
    delete process.env['WRONGSTACK_HQ_ENABLED'];
    delete process.env['WRONGSTACK_HQ_URL'];
    delete process.env['WRONGSTACK_HQ_TOKEN'];

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [],
    });
    await writeHqRuntimeFile(dataDir, { url: 'http://127.0.0.1:45680', pid: process.pid });

    const urls: string[] = [];
    const conn = startCliHqConnection({
      clientKind: 'tui',
      projectRoot: dataDir,
      projectName: 'Late token',
      retryIntervalMs: 20,
      discoveryPollMs: 20,
      socketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
    });

    await vi.waitFor(() => {
      expect(urls.length).toBeGreaterThan(0);
    });
    const before = conn.getPublisher();

    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [],
      clientTokens: [{ id: 'ct', token: 'minted-later', createdAt: new Date().toISOString() }],
    });

    await new Promise((r) => setTimeout(r, 120));
    expect(conn.getPublisher()).toBe(before);

    conn.stop();
  });

  it('follows the LIVE app config: /hq set re-points, /hq off retires, /hq on revives', () => {
    // `appConfig` is a boot snapshot; before `getAppConfig` every /hq change
    // waited for the next session, and `/hq off` could not stop a running one.
    vi.useFakeTimers();
    delete process.env['WRONGSTACK_HQ_ENABLED'];
    delete process.env['WRONGSTACK_HQ_URL'];
    delete process.env['WRONGSTACK_HQ_TOKEN'];
    const urls: string[] = [];
    let live: { hq?: { enabled?: boolean; url?: string; token?: string } } = {
      hq: { enabled: true, url: 'http://127.0.0.1:3499', token: 'tok-a' },
    };
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const connection = startCliHqConnection({
      clientKind: 'cli',
      projectRoot: '/repo',
      appConfig: live as never,
      getAppConfig: () => live as never,
      onConnect,
      onDisconnect,
      retryIntervalMs: 100,
      socketFactory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
    });
    const first = connection.getPublisher();
    expect(first).toBeDefined();
    expect(onConnect).toHaveBeenCalledTimes(1);

    live = { hq: { enabled: true, url: 'http://10.0.0.5:3499', token: 'tok-b' } };
    vi.advanceTimersByTime(150);
    const second = connection.getPublisher();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(onConnect).toHaveBeenCalledTimes(2);
    expect(urls.at(-1)).toContain('10.0.0.5');

    live = { hq: { enabled: false } };
    vi.advanceTimersByTime(150);
    expect(connection.getPublisher()).toBeUndefined();
    expect(onDisconnect).toHaveBeenCalledOnce();

    live = { hq: { enabled: true, url: 'http://10.0.0.5:3499', token: 'tok-b' } };
    vi.advanceTimersByTime(150);
    expect(connection.getPublisher()).toBeDefined();
    expect(onConnect).toHaveBeenCalledTimes(3);
    connection.stop();
  });

  it('starts polling even when HQ is disabled at boot, so /hq on works live', () => {
    vi.useFakeTimers();
    delete process.env['WRONGSTACK_HQ_ENABLED'];
    delete process.env['WRONGSTACK_HQ_URL'];
    let live: { hq?: { enabled?: boolean; url?: string } } = { hq: { enabled: false } };
    const connection = startCliHqConnection({
      clientKind: 'cli',
      projectRoot: '/repo',
      appConfig: live as never,
      getAppConfig: () => live as never,
      retryIntervalMs: 100,
      socketFactory: () => new FakeSocket(),
    });
    expect(connection.getPublisher()).toBeUndefined();
    live = { hq: { enabled: true, url: 'http://127.0.0.1:3499' } };
    vi.advanceTimersByTime(150);
    expect(connection.getPublisher()).toBeDefined();
    connection.stop();
  });

  it('an auxiliary connection does not start a second Kanban sync', () => {
    const connection = startCliHqConnection({
      clientKind: 'repl',
      projectRoot: '/repo',
      config: { enabled: true, url: 'http://127.0.0.1:3499' },
      ownKanbanSync: false,
      retryIntervalMs: 60_000,
      socketFactory: () => new FakeSocket(),
    });
    expect(connection.getPublisher()).toBeDefined();
    expect(connection.getKanbanSyncStats()).toBeUndefined();
    connection.stop();
  });
});
