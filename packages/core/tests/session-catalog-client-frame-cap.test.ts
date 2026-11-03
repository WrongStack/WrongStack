/**
 * The IPC frame cap bounds ONE response frame, matching what the daemon enforces
 * per encoded frame (`project-server.ts#send`). It must not be applied to a whole
 * socket read: TCP coalesces back-to-back writes, so two legitimate responses
 * individually under the cap arrive in one chunk, and summing them destroyed a
 * healthy connection with "response exceeded frame limit".
 *
 * Regression (bug-hunt round 18/25).
 */
import { describe, expect, it } from 'vitest';
import { SessionCatalogProjectClient } from '../src/session-catalog/client.js';
import { SESSION_CATALOG_MAX_FRAME_CHARS } from '../src/session-catalog/protocol.js';

type Settled = number;

function harness(): {
  client: SessionCatalogProjectClient;
  socket: { destroyed: boolean; destroyCalls: Error[] };
  settled: Settled[];
} {
  const dir = process.cwd();
  const client = new SessionCatalogProjectClient({ projectDir: dir, projectRoot: dir });
  const destroyCalls: Error[] = [];
  const socket = {
    destroyed: false,
    destroyCalls,
    destroy(error?: Error) {
      this.destroyed = true;
      if (error) destroyCalls.push(error);
    },
    write: () => true,
  };
  const settled: Settled[] = [];
  const pending = new Map<number, unknown>();
  for (const id of [1, 2]) {
    pending.set(id, {
      resolve: () => settled.push(id),
      reject: () => settled.push(-id),
      timer: { unref() {} } as never,
    });
  }
  const internals = client as unknown as {
    socket: unknown;
    pending: Map<number, unknown>;
    onData: (socket: unknown, chunk: string) => void;
  };
  internals.socket = socket;
  internals.pending = pending;
  return { client, socket, settled };
}

function frame(id: number, pad: string): string {
  return `${JSON.stringify({ type: 'response', id, ok: true, result: { pad } })}\n`;
}

describe('SessionCatalogProjectClient frame cap', () => {
  it('delivers several complete responses that share one read', () => {
    const { client, socket, settled } = harness();
    const pad = 'a'.repeat(Math.floor(SESSION_CATALOG_MAX_FRAME_CHARS * 0.6));
    const chunk = frame(1, pad) + frame(2, pad);
    expect(frame(1, pad).length).toBeLessThan(SESSION_CATALOG_MAX_FRAME_CHARS);
    expect(chunk.length).toBeGreaterThan(SESSION_CATALOG_MAX_FRAME_CHARS);

    (client as unknown as { onData: (socket: unknown, chunk: string) => void }).onData(
      socket,
      chunk,
    );

    expect(socket.destroyCalls).toEqual([]);
    expect(settled.sort()).toEqual([1, 2]);
  });

  it('refuses a single frame above the cap', () => {
    const { client, socket, settled } = harness();
    const chunk = frame(1, 'b'.repeat(SESSION_CATALOG_MAX_FRAME_CHARS + 10));

    (client as unknown as { onData: (socket: unknown, chunk: string) => void }).onData(
      socket,
      chunk,
    );

    expect(socket.destroyCalls.map((e) => e.message)).toEqual([
      'Session Catalog response exceeded frame limit',
    ]);
    expect(settled).toEqual([]);
  });
});
