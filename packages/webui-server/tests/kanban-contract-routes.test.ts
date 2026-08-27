import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleKanbanRoute, KANBAN_CLIENT_MESSAGE_TYPES } from '../src/server/kanban-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

/**
 * The human half of making the card contract map writable.
 *
 * The WebUI's three contract panels render `board.contractGraph` and always
 * showed the empty state, because no surface could write one — the domain API
 * existed and sat on the IPC wire allowlist with no caller. These routes close
 * that from the browser side; `packages/tools/src/kanban-contract-actions.ts`
 * closes it from the agent side.
 */
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-contract-routes-'));
});

interface SentMessage {
  type: string;
  payload: { success?: boolean; data?: unknown; error?: string };
}

function makeWs(): { ws: WebSocket; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as SentMessage);
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

function makeCtx() {
  const broadcasts: WSServerMessage[] = [];
  return {
    ctx: {
      projectRoot: tmpDir,
      // The tab that sent the request; every board event it triggers is
      // attributed to it.
      requestSessionId: '2026-08-26/sess_01TESTWEBUIKANBANROUTE00',
      broadcast: (message: WSServerMessage) => {
        broadcasts.push(message);
      },
    },
    broadcasts,
  };
}

async function seed() {
  const board = await createBoard(tmpDir, {
    title: 'Contract routes board',
    columns: [{ id: 'todo', title: 'Todo', order: 0 }],
  });
  const added = await addTask(tmpDir, board.id, { title: 'Card' });
  return { boardId: board.id, taskId: added!.task.id };
}

const send = (
  ws: WebSocket,
  ctx: { projectRoot: string; broadcast: (m: WSServerMessage) => void },
  type: string,
  payload: Record<string, unknown>,
) => handleKanbanRoute(ws, { type, payload } as never, ctx as never);

describe('kanban.contract.* routes', () => {
  it('every contract route is declared in the client message protocol', () => {
    // The registry gates by prefix, but the declared list is what the client
    // types are generated against — a route missing from it is unreachable
    // from a typed client even though the server would answer it.
    for (const type of [
      'kanban.contract.get',
      'kanban.contract.configure',
      'kanban.contract.node.upsert',
      'kanban.contract.node.remove',
      'kanban.contract.edge.add',
      'kanban.contract.edge.remove',
    ]) {
      expect(KANBAN_CLIENT_MESSAGE_TYPES).toContain(type);
    }
  });

  it('configure creates the map and broadcasts the board so panels repaint', async () => {
    const { boardId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();

    const handled = await send(ws, ctx, 'kanban.contract.configure', {
      boardId,
      enforcement: 'strict',
    });

    expect(handled).toBe(true);
    expect(sent[0]?.payload.success).toBe(true);
    expect((await getBoard(tmpDir, boardId))?.contractGraph?.enforcement).toBe('strict');
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it('upserts a node and returns it alongside the updated graph', async () => {
    const { boardId, taskId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.node.upsert', {
      boardId,
      taskId,
      kind: 'objective',
      title: 'Ship the new parser',
    });

    expect(sent[0]?.payload.success).toBe(true);
    const data = sent[0]?.payload.data as { node?: { kind?: string } };
    expect(data.node?.kind).toBe('objective');
    expect((await getBoard(tmpDir, boardId))?.contractGraph?.nodes).toHaveLength(1);
  });

  it('refuses a waived node without an actor and reason, with a field-level message', async () => {
    const { boardId, taskId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.node.upsert', {
      boardId,
      taskId,
      kind: 'guardrail',
      title: 'Legacy path stays',
      state: 'waived',
    });

    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.error).toContain('waiverActor');
  });

  it('passes a domain validation failure through instead of flattening it', async () => {
    const { boardId, taskId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.node.upsert', {
      boardId,
      taskId,
      kind: 'verification',
      title: 'Phantom',
      checkId: 'no-such-check',
    });

    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.error).toContain('binding not found');
  });

  it('adds then removes an edge', async () => {
    const { boardId, taskId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.node.upsert', {
      boardId,
      taskId,
      kind: 'artifact',
      title: 'parser.ts',
    });
    const nodeId = (await getBoard(tmpDir, boardId))!.contractGraph!.nodes[0]!.id;

    await send(ws, ctx, 'kanban.contract.edge.add', {
      boardId,
      from: taskId,
      to: nodeId,
      edgeType: 'affects',
    });
    const added = sent.at(-1);
    expect(added?.payload.success).toBe(true);
    const edgeId = (added!.payload.data as { edge: { id: string } }).edge.id;

    await send(ws, ctx, 'kanban.contract.edge.remove', { boardId, edgeId });
    expect(sent.at(-1)?.payload.success).toBe(true);
    expect(
      (await getBoard(tmpDir, boardId))!.contractGraph!.edges.some((e) => e.id === edgeId),
    ).toBe(false);
  });

  it('get returns a per-card evaluation when a taskId is supplied', async () => {
    const { boardId, taskId } = await seed();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.configure', { boardId, enforcement: 'advisory' });
    await send(ws, ctx, 'kanban.contract.get', { boardId, taskId });

    const data = sent.at(-1)?.payload.data as { evaluation?: { taskId?: string } };
    expect(data.evaluation?.taskId).toBe(taskId);
  });

  it('reports a missing board rather than throwing', async () => {
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();

    await send(ws, ctx, 'kanban.contract.get', { boardId: 'no-such-board' });
    expect(sent[0]?.payload.success).toBe(false);
  });
});
