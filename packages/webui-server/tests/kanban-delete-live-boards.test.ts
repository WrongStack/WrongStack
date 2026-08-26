import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleKanbanRoute } from '../src/server/kanban-routes.js';

/**
 * `kanban.delete` protects the board of a LIVE tab.
 *
 * The guard compared against `context.session` — the session the runtime last
 * switched to. With four tabs open that protected exactly one of four live
 * boards, and the other three could be deleted out from under the tabs
 * displaying them. The set of displayed sessions is the same one the
 * empty-session sweep already consults.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-delete-'));
});

interface SentMessage {
  type: string;
  payload: { success?: boolean; error?: string; boardId?: string; removed?: boolean };
}

function makeWs(): { ws: WebSocket; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentMessage),
  } as unknown as WebSocket;
  return { ws, sent };
}

async function boardForSession(sessionId: string) {
  const board = await createBoard(tmpDir, {
    title: `board-${sessionId}`,
    tags: [`session:${sessionId}`],
  });
  return board;
}

function ctxFor(displayed: string[] | undefined, runtimeSessionId = 'tab-1') {
  return {
    projectRoot: tmpDir,
    context: { session: { id: runtimeSessionId } },
    ...(displayed ? { getDisplayedSessionIds: () => displayed } : {}),
  } as unknown as Parameters<typeof handleKanbanRoute>[2];
}

async function tryDelete(ctx: Parameters<typeof handleKanbanRoute>[2], boardId: string) {
  const { ws, sent } = makeWs();
  await handleKanbanRoute(ws, { type: 'kanban.delete', payload: { boardId } } as never, ctx);
  return sent.at(-1);
}

describe('kanban.delete with four tabs open', () => {
  it('refuses to delete a BACKGROUND tab’s board', async () => {
    const board = await boardForSession('tab-3');
    const reply = await tryDelete(ctxFor(['tab-1', 'tab-2', 'tab-3', 'tab-4']), board.id);

    expect(reply?.payload.success).toBe(false);
    expect(await getBoard(tmpDir, board.id)).not.toBeNull();
  });

  it('still refuses the runtime session’s own board', async () => {
    const board = await boardForSession('tab-1');
    const reply = await tryDelete(ctxFor(['tab-1', 'tab-2']), board.id);

    expect(reply?.payload.success).toBe(false);
    expect(await getBoard(tmpDir, board.id)).not.toBeNull();
  });

  it('deletes a board whose session no tab is showing', async () => {
    const board = await boardForSession('closed-yesterday');
    const reply = await tryDelete(ctxFor(['tab-1', 'tab-2']), board.id);

    expect(reply?.payload.success).not.toBe(false);
    expect(await getBoard(tmpDir, board.id)).toBeNull();
  });

  it('falls back to the runtime session on a single-session host', async () => {
    // The CLI-embedded WebUI never declares tabs; its behaviour is unchanged.
    const own = await boardForSession('tab-1');
    const other = await boardForSession('tab-3');

    expect((await tryDelete(ctxFor(undefined), own.id))?.payload.success).toBe(false);
    expect((await tryDelete(ctxFor(undefined), other.id))?.payload.success).not.toBe(false);
  });
});
