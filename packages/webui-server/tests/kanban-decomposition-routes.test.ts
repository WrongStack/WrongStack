import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addCheckToTask, addTask, proposeTaskDecomposition } from '@wrongstack/kanban/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleKanbanRoute, KANBAN_CLIENT_MESSAGE_TYPES } from '../src/server/kanban-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-routes-'));
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

async function seedProposal() {
  const board = await createBoard(tmpDir, {
    title: 'Routes board',
    atomicity: { mode: 'assess', decomposition: 'propose' },
  });
  const added = await addTask(tmpDir, board.id, { title: 'Big task', description: 'much' });
  const proposed = await proposeTaskDecomposition(tmpDir, board.id, added!.task.id, {
    subtasks: [
      { title: 'Part A', description: 'a', successCriteria: ['verify: pnpm test a'] },
      { title: 'Part B', description: 'b' },
    ],
  });
  return { boardId: board.id, taskId: added!.task.id, proposalId: proposed!.proposal.id };
}

describe('kanban.decomposition.approve/reject routes', () => {
  it('approve applies the split and broadcasts board envelopes', async () => {
    const { boardId, taskId, proposalId } = await seedProposal();
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    const handled = await handleKanbanRoute(
      ws,
      { type: 'kanban.decomposition.approve', payload: { boardId, taskId, proposalId } } as never,
      ctx as never,
    );
    expect(handled).toBe(true);
    expect(sent[0]?.payload.success).toBe(true);

    const board = await getBoard(tmpDir, boardId);
    expect(board!.tasks).toHaveLength(3);
    expect(board!.tasks.find((task) => task.id === taskId)?.decomposition?.status).toBe('applied');

    const types = broadcasts.map((message) => message.type);
    expect(types).toContain('kanban.decomposition.applied');
    expect(types).toContain('kanban.get');
    expect(types).toContain('kanban.list');
    // Board-shaped payloads always ride the { board } envelope.
    const applied = broadcasts.find((message) => message.type === 'kanban.decomposition.applied');
    expect(
      (applied?.payload as { data?: { board?: { id?: string } } } | undefined)?.data?.board?.id,
    ).toBe(boardId);
  });

  it('reject resolves without children and broadcasts the task envelope', async () => {
    const { boardId, taskId, proposalId } = await seedProposal();
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanRoute(
      ws,
      {
        type: 'kanban.decomposition.reject',
        payload: { boardId, taskId, proposalId, reason: 'no' },
      } as never,
      ctx as never,
    );
    expect(sent[0]?.payload.success).toBe(true);
    const board = await getBoard(tmpDir, boardId);
    expect(board!.tasks).toHaveLength(1);
    expect(board!.tasks[0]?.decomposition?.status).toBe('rejected');
    const resolved = broadcasts.find((message) => message.type === 'kanban.decomposition.resolved');
    expect((resolved?.payload as { data?: { boardId?: string } } | undefined)?.data?.boardId).toBe(
      boardId,
    );
  });

  it('fails cleanly for an unknown proposal', async () => {
    const { boardId, taskId } = await seedProposal();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();
    await handleKanbanRoute(
      ws,
      {
        type: 'kanban.decomposition.approve',
        payload: { boardId, taskId, proposalId: 'nope' },
      } as never,
      ctx as never,
    );
    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.error).toContain('Proposal not found');
  });
});

describe('kanban.task.verify route', () => {
  it('runs verification, persists the report, and brackets with started/completed', async () => {
    const board = await createBoard(tmpDir, { title: 'Verify board' });
    const added = await addTask(tmpDir, board.id, { title: 'Check me' });
    await addCheckToTask(tmpDir, board.id, added!.task.id, {
      description: 'human confirmed',
      type: 'manual',
      status: 'passed',
    });
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanRoute(
      ws,
      {
        type: 'kanban.task.verify',
        payload: { boardId: board.id, taskId: added!.task.id },
      } as never,
      ctx as never,
    );
    expect(sent[0]?.payload.success).toBe(true);
    const types = broadcasts.map((message) => message.type);
    expect(types[0]).toBe('kanban.task.verification_started');
    expect(types).toContain('kanban.task.verification_completed');

    const persisted = await getBoard(tmpDir, board.id);
    expect(persisted!.tasks[0]?.verificationReport?.verdict).toBe('passed');
  });
});

describe('KANBAN_CLIENT_MESSAGE_TYPES parity', () => {
  it('every listed type is dispatched by the switch (never Unknown)', async () => {
    for (const type of KANBAN_CLIENT_MESSAGE_TYPES) {
      const { ws, sent } = makeWs();
      const { ctx } = makeCtx();
      const handled = await handleKanbanRoute(ws, { type, payload: {} } as never, ctx as never);
      expect(handled, type).toBe(true);
      const unknown = sent.find((message) =>
        message.payload.error?.includes('Unknown kanban message type'),
      );
      expect(unknown, type).toBeUndefined();
    }
  });
});
