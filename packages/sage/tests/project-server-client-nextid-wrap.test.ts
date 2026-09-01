/**
 * Regression: SageProjectServerConnection request ids must wrap at
 * Number.MAX_SAFE_INTEGER.
 *
 * Root cause (fixed in `request()`): `this.nextId++` saturates in float64 —
 * 2^53 + 1 is not representable, so past Number.MAX_SAFE_INTEGER every later
 * request reused the previous wire id and `pending.set(id, ...)` overwrote the
 * earlier request's routing entry. A response then resolved the wrong
 * request's promise (cross-request payload corruption) and the overwritten
 * request could only end via timeout.
 *
 * The tests drive the real production `request()` path with an injected fake
 * socket (no network) and assert the wire-id contract and pending routing.
 */
import { describe, expect, it } from 'vitest';
import { SageProjectServerConnection } from '../src/project-server-client.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

class FakeSocket {
  destroyed = false;
  readonly frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface Internals {
  socket: FakeSocket | null;
  nextId: number;
  pending: Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>;
  request(message: unknown, options: unknown): Promise<unknown>;
  onMessage(message: unknown): void;
  close(): void;
}

function makeConn(nextId?: number): { conn: Internals; sock: FakeSocket } {
  const conn = new SageProjectServerConnection('D:/regression-root') as unknown as Internals;
  const sock = new FakeSocket();
  conn.socket = sock;
  if (nextId !== undefined) conn.nextId = nextId;
  return { conn, sock };
}

function call(conn: Internals, clientId: string): Promise<unknown> {
  return conn.request(
    { type: 'request', op: 'ping', args: {}, meta: { clientId } },
    { timeoutMs: 2_000, meta: { clientId } },
  );
}

describe('SageProjectServerConnection request-id wrap', () => {
  it('keeps sequential ids from a fresh connection unchanged', () => {
    const { conn, sock } = makeConn();
    const p1 = call(conn, 'first');
    const p2 = call(conn, 'second');
    const ids = sock.frames.map((f) => (JSON.parse(f) as { id: number }).id);
    expect(ids).toEqual([1, 2]);
    expect(conn.pending.size).toBe(2);
    conn.close();
    return Promise.allSettled([p1, p2]);
  });

  it('emits MAX_SAFE_INTEGER once, then wraps to 1 instead of saturating', () => {
    const { conn, sock } = makeConn(MAX_SAFE);
    const p1 = call(conn, 'first');
    const p2 = call(conn, 'second');
    const ids = sock.frames.map((f) => (JSON.parse(f) as { id: number }).id);
    expect(ids).toEqual([MAX_SAFE, 1]);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toBeLessThanOrEqual(MAX_SAFE);
    expect(conn.nextId).toBe(2);
    conn.close();
    return Promise.allSettled([p1, p2]);
  });

  it('recovers when the counter already holds the float64-saturated value', () => {
    const { conn, sock } = makeConn(MAX_SAFE + 1); // 2^53 — what the old `++` produced
    const p1 = call(conn, 'first');
    const p2 = call(conn, 'second');
    const ids = sock.frames.map((f) => (JSON.parse(f) as { id: number }).id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(conn.pending.size).toBe(2);
    conn.close();
    return Promise.allSettled([p1, p2]);
  });

  it('routes a response frame to the request that owns its id at the wrap boundary', async () => {
    const { conn } = makeConn(MAX_SAFE + 1);
    const p1 = call(conn, 'first');
    const p2 = call(conn, 'second');
    const ids = [...conn.pending.keys()];
    conn.onMessage({ type: 'response', id: ids[0], ok: true, result: { which: 'first' } });
    const winner = await Promise.race([p1.then(() => 'p1'), p2.then(() => 'p2')]);
    expect(winner).toBe('p1');
    conn.close();
    await Promise.allSettled([p1, p2]);
  });
});
