import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleGoalGet,
  handleSessionDelete,
  handleSessionNew,
  handleSessionResume,
  handleSessionSave,
  handleSessionsList,
} from '../../src/webui-server/ws-handlers/index.js';
import type {
  SessionsContext,
  SessionsOptions,
} from '../../src/webui-server/ws-handlers/sessions.js';

/**
 * PR 5j of Issue #30: session ws-handler unit tests. A stub session store
 * + fake agent ctx drive the swapping handlers; goal.get round-trips
 * through a temp project dir. The disk-backed rewinder paths
 * (checkpoints/rewind) are covered by the runWebUI integration test.
 */

const FAKE_WS = {} as WebSocket;

let tmpDir = '';
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pr5j-'));
});
afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

function makeWriter(id: string) {
  return {
    id,
    append: async () => {},
    close: async () => {},
    truncateToCheckpoint: async () => {},
  };
}

function makeAgentCtx(sessionId: string) {
  const ctx = {
    projectRoot: tmpDir,
    model: 'm',
    provider: { id: 'anthropic' },
    session: makeWriter(sessionId),
    tokenCounter: { total: () => ({ input: 0, output: 0 }), reset: () => {}, account: () => {} },
    readFiles: new Set<string>(['x']),
    fileMtimes: new Map<string, number>([['x', 1]]),
    state: {
      replaceMessages: (m: unknown[]) => {
        ctx.messages = m;
      },
      replaceTodos: () => {},
    },
    messages: [] as unknown[],
  };
  return ctx;
}

function makeCtx(over: Partial<SessionsOptions> = {}): {
  ctx: SessionsContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
  swapped: string[];
  opts: SessionsOptions;
  agentCtx: ReturnType<typeof makeAgentCtx>;
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const swapped: string[] = [];
  const agentCtx = makeAgentCtx('startup');
  const opts: SessionsOptions = {
    projectRoot: tmpDir,
    agent: { ctx: agentCtx } as never,
    session: { id: 'startup' } as never,
    sessionStore: undefined,
    sessionsDir: undefined,
    onSessionSwapped: (id) => swapped.push(id),
    ...over,
  };
  const ctx: SessionsContext = {
    opts,
    buildSessionStart: async () => ({ sessionStart: true }),
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
  };
  return { ctx, sent, bc, swapped, opts, agentCtx };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);
const result = (sent: WsServerMessage[]) =>
  sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

describe('handleGoalGet', () => {
  it('broadcasts null when no goal.json exists', async () => {
    const { ctx, bc } = makeCtx();
    await handleGoalGet(ctx, FAKE_WS);
    expect(lastOf(bc, 'goal.updated')?.payload).toBeNull();
  });

  it('broadcasts the parsed goal when present', async () => {
    await fs.mkdir(path.join(tmpDir, '.wrongstack'));
    await fs.writeFile(
      path.join(tmpDir, '.wrongstack', 'goal.json'),
      JSON.stringify({ mission: 'ship' }),
    );
    const { ctx, bc } = makeCtx();
    await handleGoalGet(ctx, FAKE_WS);
    expect(lastOf(bc, 'goal.updated')?.payload).toEqual({ mission: 'ship' });
  });
});

describe('handleSessionsList', () => {
  it('marks the current session and maps the wire shape', async () => {
    const store = {
      list: async () => [
        { id: 'startup', title: 'a', startedAt: 1, model: 'm', provider: 'p', tokenTotal: 5 },
        { id: 'other', title: 'b', startedAt: 2, model: 'm', provider: 'p', tokenTotal: 9 },
      ],
    };
    const { ctx, sent } = makeCtx({ sessionStore: store as never });
    await handleSessionsList(ctx, FAKE_WS, 50);
    const list = (
      lastOf(sent, 'sessions.list')?.payload as {
        sessions: Array<{ id: string; isCurrent: boolean }>;
      }
    ).sessions;
    expect(list.find((s) => s.id === 'startup')?.isCurrent).toBe(true);
    expect(list.find((s) => s.id === 'other')?.isCurrent).toBe(false);
  });
});

describe('handleSessionNew', () => {
  it('swaps in a fresh writer, resets, and broadcasts session.start', async () => {
    const store = { create: async () => makeWriter('fresh') };
    const t = makeCtx({ sessionStore: store as never });
    await handleSessionNew(t.ctx, FAKE_WS);
    expect(t.agentCtx.session.id).toBe('fresh');
    expect(t.swapped).toEqual(['fresh']);
    expect(t.agentCtx.messages).toEqual([]);
    expect(lastOf(t.bc, 'session.start')).toBeDefined();
  });
});

describe('handleSessionDelete', () => {
  it('refuses to delete the active session', async () => {
    const { ctx, sent } = makeCtx();
    await handleSessionDelete(ctx, FAKE_WS, 'startup');
    expect(result(sent)).toMatchObject({ success: false });
    expect(result(sent)?.message).toContain('active session');
  });

  it('deletes a non-active session via the store', async () => {
    const deleted: string[] = [];
    const store = { delete: async (id: string) => void deleted.push(id) };
    const { ctx, sent } = makeCtx({ sessionStore: store as never });
    await handleSessionDelete(ctx, FAKE_WS, 'other');
    expect(deleted).toEqual(['other']);
    expect(result(sent)?.success).toBe(true);
  });
});

describe('handleSessionSave', () => {
  it('confirms auto-save', () => {
    const { ctx, sent } = makeCtx();
    handleSessionSave(ctx, FAKE_WS);
    expect(result(sent)).toMatchObject({
      success: true,
      message: expect.stringContaining('auto-saved'),
    });
  });
});

describe('handleSessionResume', () => {
  it('errors when no session store is wired', async () => {
    const { ctx, sent } = makeCtx({ sessionStore: undefined });
    await handleSessionResume(ctx, FAKE_WS, 'x');
    expect(result(sent)).toMatchObject({ success: false, message: 'Session store not available' });
  });

  it('refuses to resume the already-active session', async () => {
    const store = {
      resume: async () => ({ writer: makeWriter('startup'), data: { messages: [], usage: {} } }),
    };
    const { ctx, sent } = makeCtx({ sessionStore: store as never });
    await handleSessionResume(ctx, FAKE_WS, 'startup');
    expect(result(sent)?.message).toContain('already active');
  });

  it('swaps to the resumed writer and hydrates messages', async () => {
    const messages = [{ role: 'user' }, { role: 'assistant' }];
    const store = {
      resume: async () => ({
        writer: makeWriter('resumed'),
        data: { messages, usage: { input: 3, output: 1 } },
      }),
    };
    const t = makeCtx({ sessionStore: store as never });
    await handleSessionResume(t.ctx, FAKE_WS, 'resumed');
    expect(t.agentCtx.session.id).toBe('resumed');
    expect(t.swapped).toEqual(['resumed']);
    expect(t.agentCtx.messages).toEqual(messages);
    expect(result(t.sent)?.success).toBe(true);
    expect(lastOf(t.bc, 'session.start')).toBeDefined();
  });
});
