import type {
  BrainConfigPatch,
  BrainConfigSnapshot,
  BrainRuntime,
} from '@wrongstack/core/execution';
import {
  type BrainHandlerContext,
  type BrainLogEntry,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
  type WSServerMessage as WsServerMessage,
} from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

/**
 * PR 5b of Issue #30: Brain ws-handler unit tests.
 *
 * The handlers take a BrainHandlerContext; these drive them with a fake
 * context (capturing send/broadcast) and a stub arbiter so no real Brain,
 * container, or socket is involved.
 */

const FAKE_WS = {} as WebSocket;

interface Captured {
  sent: WsServerMessage[];
}

function makeCtx(over: Partial<BrainHandlerContext> = {}): {
  ctx: BrainHandlerContext;
  cap: Captured;
} {
  const cap: Captured = { sent: [] };
  const ctx: BrainHandlerContext = {
    brainSettings: { maxAutoRisk: 'medium' },
    getBrainLog: () => [],
    resolveArbiter: () => undefined,
    send: (_ws, msg) => cap.sent.push(msg),
    ...over,
  };
  return { ctx, cap };
}

const lastResultMsg = (cap: Captured) =>
  cap.sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

const lastOfType = (cap: Captured, type: string) => cap.sent.filter((m) => m.type === type).at(-1);

describe('handleBrainStatus', () => {
  it('emits the current ceiling and log', () => {
    const log: BrainLogEntry[] = [{ at: 1, kind: 'auto', question: 'q', outcome: 'allow' }];
    const { ctx, cap } = makeCtx({
      brainSettings: { maxAutoRisk: 'high' },
      getBrainLog: () => log,
    });
    handleBrainStatus(ctx, FAKE_WS);
    const msg = lastOfType(cap, 'brain.status');
    expect(msg?.payload).toEqual({ maxAutoRisk: 'high', log });
  });

  it('defaults the ceiling to medium and log to [] when unwired', () => {
    const { ctx, cap } = makeCtx({ brainSettings: undefined, getBrainLog: undefined });
    handleBrainStatus(ctx, FAKE_WS);
    expect(lastOfType(cap, 'brain.status')?.payload).toEqual({ maxAutoRisk: 'medium', log: [] });
  });
});

describe('handleBrainRisk', () => {
  it('rejects an unknown level', () => {
    const { ctx, cap } = makeCtx();
    handleBrainRisk(ctx, FAKE_WS, 'bogus');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Unknown risk level');
  });

  it('errors when brain settings are not wired', () => {
    const { ctx, cap } = makeCtx({ brainSettings: undefined });
    handleBrainRisk(ctx, FAKE_WS, 'high');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('not wired');
  });

  it('mutates the shared ceiling and echoes the new status', () => {
    const settings = { maxAutoRisk: 'low' as const };
    const { ctx, cap } = makeCtx({ brainSettings: settings });
    handleBrainRisk(ctx, FAKE_WS, 'all');
    // The SAME object is mutated (shared with /brain).
    expect(settings.maxAutoRisk).toBe('all');
    expect(lastOfType(cap, 'brain.status')?.payload).toMatchObject({ maxAutoRisk: 'all' });
  });
});

const SNAPSHOT: BrainConfigSnapshot = {
  mode: 'headless',
  maxAutoRisk: 'all',
  models: [{ provider: 'a', model: 'x' }],
  strategy: 'fallback',
  decisionTimeoutMs: undefined,
  humanTimeoutMs: undefined,
  council: {
    enabled: false,
    configured: undefined,
    minRisk: 'high',
    voters: [],
    quorum: undefined,
    approval: undefined,
    judge: undefined,
    perCallTimeoutMs: undefined,
    maxConcurrency: undefined,
    distinctness: 'none',
    judgeMaxTokens: undefined,
    voterMaxTokens: undefined,
    deliberationRounds: undefined,
    seats: [],
  },
  ledger: {
    enabled: true,
    autoDenyAfterFailures: undefined,
    path: 'C:/x/ledger.jsonl',
    maxMemoryEntries: undefined,
    interventionRetryWindowMs: undefined,
  },
  rules: [],
  ruleErrors: [],
  heuristics: {
    lowRiskAutoAnswer: true,
    blockedResolved: true,
    deadlockSkip: true,
    retryExhausted: true,
    continuePing: true,
    blockedResolvedMarkers: undefined,
  },
  llm: { maxTokens: 200, rejectUncertain: true, minConfidence: 0, denyIsTerminal: 'never' },
  trace: { enabled: false, content: 'full', path: undefined },
  monitor: {},
  terminalPolicy: 'conservative',
  decisionLogMaxEntries: 20,
  circuit: undefined,
  cache: { enabled: false, ttlMs: 300_000, maxEntries: 200, hits: 0, misses: 0, size: 0 },
  poolLabels: ['a/x'],
  councilLabels: [],
  judgeLabel: undefined,
  judgeIsVoter: false,
  usingSessionModel: false,
};

function makeRuntime(over: { persistOk?: boolean; applyThrows?: string } = {}): {
  runtime: BrainRuntime;
  patches: BrainConfigPatch[];
} {
  const patches: BrainConfigPatch[] = [];
  const runtime = {
    arbiter: { decide: vi.fn() },
    getMode: () => SNAPSHOT.mode,
    getMaxAutoRisk: () => SNAPSHOT.maxAutoRisk,
    getHumanTimeoutMs: () => undefined,
    getSnapshot: () => SNAPSHOT,
    getConfig: () => ({}),
    apply: (patch: BrainConfigPatch) => {
      if (over.applyThrows) throw new Error(over.applyThrows);
      patches.push(patch);
      return {
        snapshot: SNAPSHOT,
        persisted: Promise.resolve(
          over.persistOk === false ? { ok: false, error: 'disk full' } : { ok: true },
        ),
      };
    },
  } as unknown as BrainRuntime;
  return { runtime, patches };
}

describe('handleBrainStatus enrichment', () => {
  it('includes mode/pool/council/ledger fields when a runtime is wired', () => {
    const { runtime } = makeRuntime();
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    handleBrainStatus(ctx, FAKE_WS);
    expect(lastOfType(cap, 'brain.status')?.payload).toMatchObject({
      mode: 'headless',
      poolLabels: ['a/x'],
      councilLabels: [],
      judgeLabel: undefined,
      judgeIsVoter: false,
      ledgerPath: 'C:/x/ledger.jsonl',
    });
  });
});

describe('handleBrainConfigGet/Set', () => {
  it('config.get replies with the snapshot', () => {
    const { runtime } = makeRuntime();
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    handleBrainConfigGet(ctx, FAKE_WS);
    expect(lastOfType(cap, 'brain.config')?.payload).toMatchObject({
      config: SNAPSHOT,
      persisted: true,
    });
  });

  it('config.get decorates the snapshot with the Council persona catalog', () => {
    // The settings section used to hard-code ['executor','skeptic','auditor'],
    // which is why the registry's security / maintainer / user-advocate lenses
    // were unselectable in the browser. The catalog is served, not inlined, so
    // a lens added in core needs no WebUI change.
    const { runtime } = makeRuntime();
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });

    handleBrainConfigGet(ctx, FAKE_WS);

    const payload = lastOfType(cap, 'brain.config')?.payload as {
      config: { personaCatalog?: Array<{ id: string; name: string; description: string }> };
    };
    const ids = (payload.config.personaCatalog ?? []).map((persona) => persona.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'executor',
        'skeptic',
        'auditor',
        'security',
        'maintainer',
        'user-advocate',
      ]),
    );
    for (const persona of payload.config.personaCatalog ?? []) {
      expect(persona.name).toBeTruthy();
      expect(persona.description).toBeTruthy();
    }
  });

  it('config.get errors when no runtime is wired', () => {
    const { ctx, cap } = makeCtx();
    handleBrainConfigGet(ctx, FAKE_WS);
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('not editable');
  });

  it('config.set applies the patch, replies brain.config + refreshed status', async () => {
    const { runtime, patches } = makeRuntime();
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    await handleBrainConfigSet(ctx, FAKE_WS, { patch: { strategy: 'round-robin' } });
    expect(patches).toEqual([{ strategy: 'round-robin' }]);
    expect(lastOfType(cap, 'brain.config')?.payload).toMatchObject({ persisted: true });
    expect(lastOfType(cap, 'brain.status')).toBeDefined();
  });

  it('config.set rejects a missing/invalid patch envelope', async () => {
    const { runtime, patches } = makeRuntime();
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    await handleBrainConfigSet(ctx, FAKE_WS, { patch: 'nope' });
    expect(patches).toEqual([]);
    expect(lastResultMsg(cap)?.success).toBe(false);
  });

  it('config.set surfaces apply() validation errors as brain.config error', async () => {
    const { runtime } = makeRuntime({ applyThrows: 'Invalid maxAutoRisk: extreme' });
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    await handleBrainConfigSet(ctx, FAKE_WS, { patch: { maxAutoRisk: 'extreme' } });
    const payload = lastOfType(cap, 'brain.config')?.payload as {
      persisted: boolean;
      error?: string;
    };
    expect(payload.persisted).toBe(false);
    expect(payload.error).toContain('Invalid maxAutoRisk');
  });

  it('config.set reports persist failure while keeping the live change', async () => {
    const { runtime, patches } = makeRuntime({ persistOk: false });
    const { ctx, cap } = makeCtx({ brainRuntime: runtime });
    await handleBrainConfigSet(ctx, FAKE_WS, { patch: { mode: 'headless' } });
    expect(patches).toEqual([{ mode: 'headless' }]);
    const payload = lastOfType(cap, 'brain.config')?.payload as {
      persisted: boolean;
      error?: string;
    };
    expect(payload.persisted).toBe(false);
    expect(payload.error).toContain('disk full');
  });
});

describe('handleBrainAsk', () => {
  it('rejects an empty question', async () => {
    const { ctx, cap } = makeCtx();
    await handleBrainAsk(ctx, FAKE_WS, '   ');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Usage');
  });

  it('errors when no arbiter is wired', async () => {
    const { ctx, cap } = makeCtx({ resolveArbiter: () => undefined });
    await handleBrainAsk(ctx, FAKE_WS, 'should we deploy?');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('No Brain');
  });

  it('forwards the question to the arbiter and emits the answer', async () => {
    const decision = { action: 'allow', reason: 'ok' };
    const seen: Array<{ question: string; risk: string }> = [];
    const { ctx, cap } = makeCtx({
      resolveArbiter: () =>
        ({
          decide: async (req: { question: string; risk: string }) => {
            seen.push({ question: req.question, risk: req.risk });
            return decision as never;
          },
        }) as never,
    });
    await handleBrainAsk(ctx, FAKE_WS, '  ship it?  ');
    // trims the question before forwarding
    expect(seen).toEqual([{ question: 'ship it?', risk: 'medium' }]);
    expect(lastOfType(cap, 'brain.answer')?.payload).toEqual({
      question: 'ship it?',
      decision,
    });
  });

  it('reports a friendly error when the arbiter throws', async () => {
    const { ctx, cap } = makeCtx({
      resolveArbiter: () =>
        ({
          decide: async () => {
            throw new Error('brain offline');
          },
        }) as never,
    });
    await handleBrainAsk(ctx, FAKE_WS, 'q?');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Brain consultation failed');
    expect(lastResultMsg(cap)?.message).toContain('brain offline');
  });
});
