/**
 * End-to-end: a board too large for HQ, against a real HQ server over a real
 * WebSocket.
 *
 * The unit tests around `kanban-hq-sync.ts` pin the sender's decision against a
 * mocked publisher, so they cannot see what HQ actually does with the frame.
 * Two facts only a real server established, and both corrected a wrong belief:
 *
 *   1. The publisher SUMMARISES strings over 100 KB before sending. A board
 *      that is large because of one long field therefore arrives fine, and
 *      measuring the raw board would have dropped it — trading a truncated
 *      description for a board that never appears. Only a board large from
 *      MANY cards stays over the limit on the wire.
 *   2. An oversized board never endangered its chunk-mates. The chunk target is
 *      512 KB and the reject threshold 750 KB, so anything big enough to be
 *      rejected is already alone in its chunk. The harm was always exactly one
 *      board going missing — silently, permanently, on both sides.
 *
 * What this asserts, end to end:
 *   - the genuinely oversized board never reaches HQ
 *   - the board redaction can rescue DOES reach HQ
 *   - the sender warns, naming the board and its wire size
 *   - HQ logs no `hq.event_payload_rejected` — because nothing invalid is sent
 *   - the skipped board is retried once it shrinks (its fingerprint was never
 *     written)
 *
 * @vitest-environment node
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveHqProjectId,
  HQ_AUTH_FILE_VERSION,
  HqPublisher,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { createBoard, getBoard, writeBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { createKanbanHqSync } from '../src/kanban-hq-sync.js';

let tempRoot: string;
let dataDir: string;
let projectRoot: string;
let handle: HqServerHandle | null = null;
let sync: ReturnType<typeof createKanbanHqSync> | null = null;
let publisher: HqPublisher | null = null;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-kanban-oversized-'));
  dataDir = path.join(tempRoot, 'hq');
  projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  sync?.stop();
  sync = null;
  publisher?.close();
  publisher = null;
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  vi.restoreAllMocks();
});

function socketFactory(url: string) {
  return new WebSocket(url) as unknown as ConstructorParameters<
    typeof HqPublisher
  >[0]['socketFactory'] extends undefined
    ? never
    : ReturnType<NonNullable<ConstructorParameters<typeof HqPublisher>[0]['socketFactory']>>;
}

async function startServer(): Promise<string> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  handle = await startHqServer({
    host: '127.0.0.1',
    port: 30_000 + Math.floor(Math.random() * 9_000),
    dataDir,
  });
  return `http://127.0.0.1:${handle.port}`;
}

/**
 * Grow a board past a byte target with MANY cards rather than one long string.
 *
 * This is the distinction that decides the whole behavior. `publishEvent`
 * summarises any string over 100 KB before sending, so a board that is large
 * because of one enormous field shrinks on the wire and reaches HQ fine — and
 * must not be skipped. A board that is large because it holds hundreds of
 * ordinary cards has no single string long enough to summarise, so it stays
 * over the limit and is the one HQ actually rejects.
 */
async function growWithCards(boardId: string, targetBytes: number): Promise<number> {
  const board = await getBoard(projectRoot, boardId);
  if (!board) throw new Error(`board vanished: ${boardId}`);
  const filler = 'card body '.repeat(120); // ~1.2 KB, well under the summary cap
  let index = 0;
  while (Buffer.byteLength(JSON.stringify(board), 'utf8') < targetBytes) {
    board.tasks.push({
      id: `bulk-${index}`,
      title: `Bulk card ${index}`,
      description: `${filler}#${index}`,
      columnId: board.columns[0]?.id ?? 'todo',
      order: index,
      priority: 'medium',
      status: 'pending',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    } as (typeof board.tasks)[number]);
    index += 1;
  }
  await writeBoard(projectRoot, board);
  const stored = await getBoard(projectRoot, boardId);
  return Buffer.byteLength(JSON.stringify(stored), 'utf8');
}

/** Grow a board with a single long field — the case redaction rescues. */
async function growWithOneLongField(boardId: string, bytes: number): Promise<number> {
  const board = await getBoard(projectRoot, boardId);
  if (!board) throw new Error(`board vanished: ${boardId}`);
  board.description = 'x'.repeat(bytes);
  await writeBoard(projectRoot, board);
  const stored = await getBoard(projectRoot, boardId);
  return Buffer.byteLength(JSON.stringify(stored), 'utf8');
}

async function boardIdsInHq(
  base: string,
  projectId: string,
  atLeast: number,
): Promise<Set<string>> {
  const deadline = Date.now() + 20_000;
  let ids = new Set<string>();
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/kanban`);
    if (response.ok) {
      const snapshot = (await response.json()) as { boards?: Array<{ boardId: string }> };
      ids = new Set((snapshot.boards ?? []).map((record) => record.boardId));
      if (ids.size >= atLeast) return ids;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ids;
}

describe('oversized Kanban board against a live HQ', () => {
  it('skips only the oversized board, delivers the rest, and stays audible', async () => {
    const base = await startServer();
    const hqWarnings: string[] = [];
    // HQ's own rejection log goes through console.warn as a JSON line.
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      hqWarnings.push(args.map(String).join(' '));
    });
    const emitted: Array<{ message: string; code: unknown }> = [];
    vi.spyOn(process, 'emitWarning').mockImplementation(((message: unknown, options: unknown) => {
      emitted.push({
        message: String(message),
        code: (options as { code?: unknown } | undefined)?.code,
      });
    }) as typeof process.emitWarning);

    const huge = await createBoard(projectRoot, { title: 'Huge board' });
    const hugeBytes = await growWithCards(huge.id, 800_000);
    expect(hugeBytes, 'fixture must actually exceed the HQ per-board limit').toBeGreaterThan(
      750_000,
    );

    // The board redaction CAN rescue: one long field, summarised on the way out.
    // It must still reach HQ — skipping it would trade a truncated description
    // for a board that never appears.
    const longField = await createBoard(projectRoot, { title: 'One long field' });
    expect(await growWithOneLongField(longField.id, 800_000)).toBeGreaterThan(750_000);

    // Sized so the publish must split into several chunks — this also exercises
    // the per-chunk coalesce key, without which only the last chunk survives a
    // reconnect.
    const normal: string[] = [longField.id];
    for (let index = 0; index < 3; index += 1) {
      const board = await createBoard(projectRoot, { title: `Normal board ${index}` });
      await growWithOneLongField(board.id, 200_000);
      normal.push(board.id);
    }

    const projectId = deriveHqProjectId(projectRoot);
    publisher = new HqPublisher({
      url: base,
      client: {
        clientId: 'e2e-oversized',
        kind: 'tui',
        machineId: 'e2e-machine',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId,
        projectRoot,
        projectName: 'e2e',
        machineId: 'e2e-machine',
        workspaceKind: 'git',
      },
      socketFactory: socketFactory as never,
    });
    publisher.connect();

    sync = createKanbanHqSync(projectRoot, projectId);
    await sync.attachPublisher(publisher);

    const arrived = await boardIdsInHq(base, projectId, normal.length);
    expect(arrived.has(huge.id), 'oversized board must not reach HQ').toBe(false);
    for (const id of normal) {
      // Includes the one-long-field board: redaction shrinks it, so it belongs
      // in HQ. A size check on the raw board would silently drop it.
      expect(arrived.has(id), `board ${id} should have reached HQ`).toBe(true);
    }

    const dropped = emitted.filter((entry) => entry.code === 'WRONGSTACK_HQ_KANBAN_BOARD_DROPPED');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.message).toContain(huge.id);
    expect(dropped[0]?.message, 'the warning should state the actual size').toMatch(/\d{6,}/);

    expect(
      hqWarnings.filter((line) => line.includes('hq.event_payload_rejected')),
      'nothing invalid should be sent, so HQ should have nothing to reject',
    ).toEqual([]);

    // The fingerprint was never written for the skipped board, so shrinking it
    // is enough to get it published — no restart, no full rescan.
    const shrunk = await getBoard(projectRoot, huge.id);
    if (!shrunk) throw new Error('board vanished');
    shrunk.tasks = [];
    await writeBoard(projectRoot, shrunk);
    sync.refresh(huge.id);
    const afterShrink = await boardIdsInHq(base, projectId, normal.length + 1);
    expect(afterShrink.has(huge.id), 'shrunken board should publish on the next round').toBe(true);
  }, 60_000);
});
