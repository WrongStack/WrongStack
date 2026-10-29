import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSessionHandlers } from '../src/server/session-handlers.js';

type Frame = { type: string; payload: Record<string, unknown> };

function handlers(summaries: Array<Record<string, unknown>>, list = vi.fn(async () => summaries)) {
  const frames: Frame[] = [];
  const ctx = {
    session: { id: 'tab-1' },
    fileMtimes: new Map<string, number>(),
    state: { messages: [], todos: [], replaceMessages: () => undefined },
  };
  const created = createSessionHandlers({
    config: { model: 'm', provider: 'p' },
    context: ctx as never,
    tokenCounter: { account: () => undefined, total: () => ({}), reset: () => undefined } as never,
    getProjectRoot: () => '/repo',
    getSession: () => ctx.session as never,
    setSession: () => undefined,
    getSessionStore: () => ({ list }) as never,
    hasSession: () => true,
    sessionStartPayload: async (overrides?: Record<string, unknown>) => ({ ...overrides }),
    sendMessage: ((_ws: WebSocket, msg: unknown) => frames.push(msg as Frame)) as never,
    broadcastMessage: () => undefined,
  } as never);
  return { created, frames, list };
}

const summary = (id: string, provider: string, model: string, tokenTotal: unknown) => ({
  id,
  title: id,
  startedAt: '2026-10-29T00:00:00Z',
  provider,
  model,
  tokenTotal,
});

describe('project usage summary from the session catalog', () => {
  it('totals recorded tokens per provider and model without inventing prices', async () => {
    const { created, frames, list } = handlers([
      summary('a', 'openai', 'gpt-x', 1200),
      summary('b', 'openai', 'gpt-x', 800),
      summary('c', 'anthropic', 'claude-y', 500),
      summary('d', 'anthropic', 'claude-y', Number.NaN),
    ]);
    await created.listSessions(
      {} as WebSocket,
      {
        type: 'sessions.list',
        payload: { usageSummary: true, sessionId: 'tab-1' },
      } as never,
    );
    expect(list).toHaveBeenCalledWith(5000);
    const usage = frames.at(-1)?.payload['usageSummary'];
    expect(usage).toEqual({
      sessions: 4,
      sessionsWithTokens: 3,
      tokenTotal: 2500,
      capped: false,
      byModel: [
        { provider: 'openai', model: 'gpt-x', sessions: 2, tokenTotal: 2000 },
        { provider: 'anthropic', model: 'claude-y', sessions: 2, tokenTotal: 500 },
      ],
    });
    expect(JSON.stringify(usage)).not.toMatch(/cost|usd|price/i);
  });

  it('says when the scan reached its bound', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => summary(`s${i}`, 'p', 'm', 1));
    const { created, frames } = handlers(many);
    await created.listSessions(
      {} as WebSocket,
      {
        type: 'sessions.list',
        payload: { usageSummary: true },
      } as never,
    );
    expect(frames.at(-1)?.payload['usageSummary']).toMatchObject({ sessions: 5000, capped: true });
  });
});
