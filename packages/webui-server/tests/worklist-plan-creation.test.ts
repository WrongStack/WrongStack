import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handlePlanGet, type WorklistContext } from '../src/server/handlers/worklist-handlers.js';
import type { WSServerMessage } from '../src/server/types.js';

describe('handlePlanGet', () => {
  it('creates a durable empty PLAN for a session that does not have one yet', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wrongstack-plan-get-'));
    const planPath = path.join(dir, 'session-a.plan.json');
    const sent: WSServerMessage[] = [];
    const ctx: WorklistContext = {
      context: {
        todos: [],
        meta: { 'plan.path': planPath },
        session: { id: 'session-a' },
      },
      send: (_ws, message) => sent.push(message),
      broadcast: vi.fn(),
    };

    await handlePlanGet(ctx, {} as WebSocket);

    const persisted = JSON.parse(await readFile(planPath, 'utf8')) as {
      sessionId: string;
      items: unknown[];
    };
    expect(persisted).toMatchObject({ sessionId: 'session-a', items: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'plan.updated',
      payload: { sessionId: 'session-a', plan: { sessionId: 'session-a', items: [] } },
    });
  });
});
