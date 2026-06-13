import { DEFAULT_CONTEXT_WINDOW_MODE_ID, TOKENS } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { ContextHandlerContext } from '../../src/webui-server/ws-handlers/context.js';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleContextClear,
  handleContextCompact,
  handleContextDebug,
  handleContextModeCreate,
  handleContextModeDelete,
  handleContextModeSwitch,
  handleContextModesList,
  handleContextModeUpdate,
  handleContextRepair,
} from '../../src/webui-server/ws-handlers/index.js';

/**
 * PR 5h of Issue #30: context ws-handler unit tests.
 *
 * Drives the handlers with a fake agent ctx, a stub compactor (via the
 * container), and a stub custom-mode store. estimateContextBreakdown and
 * repairToolUseAdjacency run for real against minimal inputs.
 */

const FAKE_WS = {} as WebSocket;

function makeModeStore() {
  const modes: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  return {
    list: () => modes,
    create: (m: Record<string, unknown>) => {
      calls.push('create');
      if (modes.some((x) => x.id === m.id)) return { ok: false, error: 'exists' };
      modes.push(m);
      return { ok: true };
    },
    update: (id: string, patch: Record<string, unknown>) => {
      calls.push('update');
      const m = modes.find((x) => x.id === id);
      if (!m) return { ok: false, error: 'missing' };
      Object.assign(m, patch);
      return { ok: true };
    },
    remove: (id: string) => {
      calls.push('remove');
      const i = modes.findIndex((x) => x.id === id);
      if (i < 0) return { ok: false, error: 'missing' };
      modes.splice(i, 1);
      return { ok: true };
    },
    save: async () => {
      calls.push('save');
    },
    _calls: calls,
    _modes: modes,
  };
}

function makeCtx(
  over: { compactor?: unknown; modeStore?: ReturnType<typeof makeModeStore> } = {},
): {
  ctx: ContextHandlerContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
  builtWith: unknown[];
  actx: Record<string, unknown>;
  modeStore: ReturnType<typeof makeModeStore>;
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const builtWith: unknown[] = [];
  const modeStore = over.modeStore ?? makeModeStore();
  const actx = {
    meta: {} as Record<string, unknown>,
    messages: [] as unknown[],
    systemPrompt: [] as unknown[],
    readFiles: new Set<string>(['a']),
    fileMtimes: new Map<string, number>([['a', 1]]),
    tokenCounter: { total: () => ({ input: 100, output: 50 }) },
    state: {
      replaceMessages: (m: unknown[]) => {
        actx.messages = m;
      },
      replaceTodos: () => {},
    },
  };
  const ctx: ContextHandlerContext = {
    agent: {
      ctx: actx,
      tools: { list: () => [] },
      container: { resolve: (t: symbol) => (t === TOKENS.Compactor ? over.compactor : undefined) },
    } as never,
    buildSessionStart: async (o) => {
      builtWith.push(o);
      return { sessionStart: true };
    },
    getCustomModeStore: async () => modeStore as never,
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
  };
  return { ctx, sent, bc, builtWith, actx, modeStore };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);
const result = (sent: WsServerMessage[]) =>
  sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

describe('handleContextClear', () => {
  it('wipes state and broadcasts a reset session.start', async () => {
    const { ctx, bc, builtWith, actx } = makeCtx();
    actx.messages = [{ role: 'user' }];
    await handleContextClear(ctx, FAKE_WS);
    expect(actx.messages).toEqual([]);
    expect(builtWith).toEqual([{ reset: true }]);
    expect(lastOf(bc, 'session.start')).toBeDefined();
  });
});

describe('handleContextDebug', () => {
  it('sends a breakdown with the active mode', () => {
    const { ctx, sent } = makeCtx();
    handleContextDebug(ctx, FAKE_WS);
    const p = lastOf(sent, 'context.debug')?.payload as { mode: string };
    expect(p.mode).toBe(DEFAULT_CONTEXT_WINDOW_MODE_ID);
  });
});

describe('handleContextCompact', () => {
  it('errors when no compactor is available', async () => {
    const { ctx, sent } = makeCtx({ compactor: undefined });
    await handleContextCompact(ctx, FAKE_WS, false);
    expect(result(sent)).toMatchObject({ success: false, message: 'Compactor not available' });
  });

  it('reports the token delta on success', async () => {
    const compactor = { compact: async () => ({ reductions: [], repaired: true }) };
    const { ctx, sent } = makeCtx({ compactor });
    await handleContextCompact(ctx, FAKE_WS, true);
    expect(lastOf(sent, 'context.compacted')?.payload).toMatchObject({ repaired: true });
    expect(result(sent)?.success).toBe(true);
  });
});

describe('handleContextRepair', () => {
  it('reports no orphans for a clean message list', () => {
    const { ctx, sent, bc } = makeCtx();
    handleContextRepair(ctx, FAKE_WS);
    expect(lastOf(bc, 'context.repaired')).toBeDefined();
    expect(result(sent)?.message).toContain('no orphan');
  });
});

describe('context modes', () => {
  it('modes.list reports the active id', async () => {
    const { ctx, sent } = makeCtx();
    await handleContextModesList(ctx, FAKE_WS);
    const p = lastOf(sent, 'context.modes.list')?.payload as { activeId: string };
    expect(p.activeId).toBe(DEFAULT_CONTEXT_WINDOW_MODE_ID);
  });

  it('mode.switch to a built-in updates meta + broadcasts', async () => {
    const { ctx, sent, bc, actx } = makeCtx();
    await handleContextModeSwitch(ctx, FAKE_WS, DEFAULT_CONTEXT_WINDOW_MODE_ID);
    expect(result(sent)?.success).toBe(true);
    expect(actx.meta).toMatchObject({ contextWindowMode: DEFAULT_CONTEXT_WINDOW_MODE_ID });
    expect(lastOf(bc, 'context.mode.changed')).toBeDefined();
  });

  it('mode.switch rejects an unknown id', async () => {
    const { ctx, sent } = makeCtx();
    await handleContextModeSwitch(ctx, FAKE_WS, 'totally-unknown-mode');
    expect(result(sent)).toMatchObject({ success: false });
    expect(result(sent)?.message).toContain('Unknown context mode');
  });

  it('create → update → delete a custom mode (with persistence)', async () => {
    const t = makeCtx();
    await handleContextModeCreate(t.ctx, FAKE_WS, {
      id: 'mine',
      name: 'Mine',
      description: 'd',
      thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
      preserveK: 4,
      eliseThreshold: 0.5,
    });
    expect(result(t.sent)?.success).toBe(true);

    await handleContextModeUpdate(t.ctx, FAKE_WS, { id: 'mine', name: 'Renamed' });
    expect(t.modeStore._modes[0]?.name).toBe('Renamed');

    await handleContextModeDelete(t.ctx, FAKE_WS, 'mine');
    expect(t.modeStore._modes).toHaveLength(0);
    // saved after each successful mutation.
    expect(t.modeStore._calls.filter((c) => c === 'save').length).toBe(3);
  });

  it('deleting the active custom mode falls back to default', async () => {
    const t = makeCtx();
    t.actx.meta['contextWindowMode'] = 'mine';
    await handleContextModeCreate(t.ctx, FAKE_WS, {
      id: 'mine',
      name: 'Mine',
      description: 'd',
      thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
      preserveK: 4,
      eliseThreshold: 0.5,
    });
    await handleContextModeDelete(t.ctx, FAKE_WS, 'mine');
    expect(t.actx.meta['contextWindowMode']).toBe(DEFAULT_CONTEXT_WINDOW_MODE_ID);
  });
});
