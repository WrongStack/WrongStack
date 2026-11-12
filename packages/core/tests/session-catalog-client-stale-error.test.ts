import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCatalogProjectClient } from '../src/session-catalog/client.js';
import { sessionCatalogProjectServerMetadataPath } from '../src/session-catalog/endpoint.js';

interface ControlledSocket extends EventEmitter {
  destroyed: boolean;
  write(data: string): boolean;
  end(): void;
}
const boundary = vi.hoisted(() => ({ sockets: [] as ControlledSocket[] }));
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    destroyed = false;
    setEncoding() {
      return this;
    }
    destroy() {
      this.destroyed = true;
      return this;
    }
    end() {
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    }
    write(data: string) {
      const request = JSON.parse(data);
      queueMicrotask(() =>
        this.emit(
          'data',
          JSON.stringify({
            type: 'response',
            id: request.id,
            ok: true,
            result: [],
          }) + '\n',
        ),
      );
      return true;
    }
  }
  return {
    ...actual,
    createConnection: vi.fn(() => {
      const socket = new Socket();
      boundary.sockets.push(socket);
      return socket;
    }),
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  boundary.sockets.length = 0;
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^catalog-stale-handshake-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(liveOwner = true) {
  vi.useFakeTimers();
  vi.stubEnv('WRONGSTACK_CATALOG_DAEMON_LOG', '');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-stale-handshake-'));
  roots.push(root);
  // callExisting may retry an endpoint whose recorded owner is alive, but never spawns.
  fs.writeFileSync(
    sessionCatalogProjectServerMetadataPath(root),
    JSON.stringify({ pid: liveOwner ? process.pid : 2_147_483_647 }),
  );
  const client = new SessionCatalogProjectClient({ projectDir: root, projectRoot: root });
  const hello = (socket: ControlledSocket) =>
    socket.emit(
      'data',
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        projectDir: root,
        projectRoot: root,
        pid: process.pid,
        instanceId: 'controlled-daemon',
        databasePath: path.join(root, 'catalog.sqlite'),
        startedAt: new Date(0).toISOString(),
      }) + '\n',
    );
  return { client, hello };
}

describe('Session Catalog handshake socket ownership', () => {
  it('completes an ordinary current handshake and correlated call (control)', async () => {
    const { client, hello } = fixture();
    const pending = client.callExisting('list_live', {});
    try {
      expect(boundary.sockets).toHaveLength(1);
      hello(boundary.sockets[0]!);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual([]);
    } finally {
      await client.close();
      await vi.runAllTimersAsync();
    }
  });

  it('ignores a retired socket error while the replacement handshake is pending', async () => {
    const { client, hello } = fixture();
    let outcome: { state: string; value?: unknown } = { state: 'pending' };
    const pending = client.callExisting('list_live', {}).then(
      (value) => {
        outcome = { state: 'resolved', value };
      },
      (error) => {
        outcome = { state: 'rejected', value: String(error) };
      },
    );
    try {
      const retired = boundary.sockets[0]!;
      retired.emit('error', new Error('First handshake attempt failed'));
      await vi.advanceTimersByTimeAsync(75);
      expect(boundary.sockets).toHaveLength(2);
      expect(retired.destroyed).toBe(true);
      // The old OS operation completes after replacement, before its close notification.
      retired.emit('error', new Error('Late error from retired transport'));
      hello(boundary.sockets[1]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome, 'a retired socket must not poison a valid current handshake').toEqual({
        state: 'resolved',
        value: [],
      });
      await pending;
      expect(boundary.sockets).toHaveLength(2);
    } finally {
      await client.close();
      await vi.runAllTimersAsync();
      await pending;
    }
  });

  it('still rejects the current handshake when its own transport fails', async () => {
    const { client } = fixture(false);
    const pending = client.callExisting('list_live', {});
    const rejected = expect(pending).rejects.toThrow('Current transport failed');
    try {
      boundary.sockets[0]!.emit('error', new Error('Current transport failed'));
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(boundary.sockets).toHaveLength(1);
    } finally {
      await client.close();
      await vi.runAllTimersAsync();
    }
  });

  it('keeps retired data and close notifications outside the replacement handshake', async () => {
    const { client, hello } = fixture();
    const pending = client.callExisting('list_live', {});
    try {
      const retired = boundary.sockets[0]!;
      retired.emit('error', new Error('First handshake attempt failed'));
      await vi.advanceTimersByTimeAsync(75);
      expect(boundary.sockets).toHaveLength(2);
      retired.emit(
        'data',
        JSON.stringify({ type: 'hello', protocolVersion: 999, projectRoot: 'wrong' }) + '\n',
      );
      retired.emit('close');
      hello(boundary.sockets[1]!);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toEqual([]);
      expect(boundary.sockets).toHaveLength(2);
    } finally {
      await client.close();
      await vi.runAllTimersAsync();
    }
  });
});
