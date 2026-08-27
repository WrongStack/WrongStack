import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import { EventBus } from '../../src/kernel/events.js';
import type { SessionEventBridge } from '../../src/storage/session-event-bridge.js';
import type { Compactor } from '../../src/types/compactor.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';

function mockContext(_tokenEstimate: number): Context {
  const ctx = {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: {} as any,
    // Compaction emits agent events, and every one names the owning session.
    session: { id: '2026-08-26/sess_01TESTAUTOCOMPACTION00000' } as any,
    signal: new AbortController().signal,
    tokenCounter: {} as any,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
    tools: [],
    meta: {},
    clearFileTracking: () => {},
  } as never as Context;
  let revision = 0;
  Object.defineProperty(ctx, 'state', {
    value: {
      get revision() {
        return revision;
      },
      replaceMessages(messages: Context['messages']) {
        ctx.messages = messages;
        revision++;
      },
    },
  });
  return ctx;
}

function mockCompactor(): Compactor & { compactCalls: { ctx: Context; aggressive: boolean }[] } {
  return {
    compactCalls: [],
    async compact(ctx, opts = {}) {
      this.compactCalls.push({ ctx, aggressive: opts.aggressive ?? false });
      return {
        before: 1000,
        after: 800,
        fullRequestTokensBefore: 1000,
        fullRequestTokensAfter: 800,
        reductions: [],
      };
    },
  };
}

function simpleEstimator(tokens: number): (ctx: Context) => number {
  return () => tokens;
}

describe('AutoCompactionMiddleware', () => {
  let compactor: ReturnType<typeof mockCompactor>;

  beforeEach(() => {
    compactor = mockCompactor();
  });

  it('does not compact when load is below warn threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(3000); // 30% load
    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true);
    expect(compactor.compactCalls).toHaveLength(0);
  });

  it('prunes consumed raw tool I/O below warn while preserving the pending batch', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(3000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.meta['contextWindowPolicy'] = { eliseThreshold: 50 };
    ctx.lastRequestTokens = 9_000;
    ctx.lastRealInputTokens = 8_500;
    ctx.meta['lastRequestTokensAt'] = { msgCount: 5, toolCount: 0 };
    ctx.meta['realAnchorMsgCount'] = 5;
    ctx.messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'consumed',
            name: 'exec',
            input: { path: 'src/consumed.ts', content: 'a'.repeat(2_000) },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'consumed',
            name: 'exec',
            content: 'old result '.repeat(1_000),
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'consumed' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'pending', name: 'read', input: { path: 'src/pending.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'pending',
            name: 'read',
            content: 'pending result '.repeat(1_000),
          },
        ],
      },
    ];

    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(0);
    expect(JSON.stringify(ctx.messages[1])).toContain('[elided:');
    expect(JSON.stringify(ctx.messages[4])).toContain('pending result pending result');
    expect(ctx.lastRequestTokens).toBeUndefined();
    expect(ctx.lastRealInputTokens).toBeUndefined();
    expect(ctx.meta['lastRequestTokensAt']).toBeUndefined();
    expect(ctx.meta['realAnchorMsgCount']).toBeUndefined();
  });

  function pushAcknowledgedExchanges(ctx: Context, count: number): void {
    for (let i = 0; i < count; i++) {
      ctx.messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `use-${i}`, name: 'exec', input: { path: `${i}.ts` } }],
      });
      ctx.messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `use-${i}`,
            name: 'exec',
            content: `result ${i}`,
          },
        ],
      });
    }
    ctx.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  }

  it('leaves acknowledged protocol byte-identical below warn so the prompt prefix stays cacheable', async () => {
    // Collapsing receipts rewrites messages the provider has already seen,
    // which costs a full prompt re-cache. Below warn there is no pressure
    // justifying that, so history must stay append-only.
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(3000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.meta['contextWindowPolicy'] = { preserveK: 1, eliseThreshold: 50 };
    pushAcknowledgedExchanges(ctx, 20);
    const before = JSON.stringify(ctx.messages);

    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(0);
    expect(JSON.stringify(ctx.messages)).toBe(before);
  });

  it('bounds acknowledged protocol receipts once pressure reaches warn', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(5000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.meta['contextWindowPolicy'] = { preserveK: 1, eliseThreshold: 50 };
    pushAcknowledgedExchanges(ctx, 20);

    await mw.handler()(ctx, async (c) => c);

    expect(JSON.stringify(ctx.messages[0])).toContain('[tool_history_digest: 4');
    expect(
      ctx.messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.filter((block) => block.type === 'tool_result'),
      ),
    ).toHaveLength(16);
  });

  it('does not re-collapse on the next turn until the context grows by the hygiene interval', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(5000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.meta['contextWindowPolicy'] = { preserveK: 1, eliseThreshold: 50 };
    pushAcknowledgedExchanges(ctx, 20);

    await mw.handler()(ctx, async (c) => c);
    const afterFirst = JSON.stringify(ctx.messages);

    // A further acknowledged exchange arrives; the digest counter would move
    // again under per-turn hygiene, invalidating the whole cached prefix.
    ctx.messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'use-next', name: 'exec', input: { path: 'next.ts' } }],
    });
    ctx.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'use-next', name: 'exec', content: 'result next' },
      ],
    });
    ctx.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done again' }] });
    const beforeSecond = JSON.stringify(ctx.messages);

    await mw.handler()(ctx, async (c) => c);

    expect(JSON.stringify(ctx.messages)).toBe(beforeSecond);
    expect(afterFirst).not.toBe(beforeSecond);
  });

  it('keeps a useful raw investigation window and semantically receipts only the overflow', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 200_000, simpleEstimator(115_000), {
      warn: 0.55,
      soft: 0.7,
      hard: 0.85,
    });
    const ctx = mockContext(0);
    ctx.meta['contextWindowPolicy'] = { preserveK: 8, eliseThreshold: 1_200 };
    for (let i = 0; i < 4; i++) {
      ctx.messages.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `read-${i}`, name: 'grep', input: { path: `src/${i}.ts` } },
        ],
      });
      ctx.messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `read-${i}`,
            name: 'grep',
            content: `IMPORTANT_HEAD_${i}\n${'x'.repeat(10_000)}\nIMPORTANT_TAIL_${i}`,
          },
        ],
      });
    }
    ctx.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'reads consumed' }] });

    await mw.handler()(ctx, async (c) => c);

    const wire = JSON.stringify(ctx.messages);
    expect(wire).toContain('IMPORTANT_HEAD_0');
    expect(wire).toContain('IMPORTANT_TAIL_0');
    expect(JSON.stringify(ctx.messages[1])).toContain('[elided:');
    expect(JSON.stringify(ctx.messages[1])).not.toContain('x'.repeat(1_000));
    for (let i = 1; i < 4; i++) {
      const rawResult = JSON.stringify(ctx.messages[i * 2 + 1]);
      expect(rawResult).toContain(`IMPORTANT_HEAD_${i}\\n${'x'.repeat(1_000)}`);
      expect(rawResult).toContain(`IMPORTANT_TAIL_${i}`);
    }
  });

  it('rejects a stale aggregate stash after a same-length state rewrite', async () => {
    const mw = new AutoCompactionMiddleware(
      compactor,
      10_000,
      undefined,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );
    const ctx = mockContext(0);
    ctx.messages = [{ role: 'user', content: 'small' }];
    ctx.lastRequestTokens = 100;
    ctx.meta['lastRequestTokensAt'] = { msgCount: 1, toolCount: 0, revision: 0 };

    // Count is unchanged, but revision and content are not. A count-only
    // cache key would incorrectly reuse 100 and skip compaction.
    ctx.state.replaceMessages([{ role: 'user', content: 'x'.repeat(40_000) }]);
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
  });

  it('invalidates every token cache after a same-length pressure rewrite', async () => {
    const rewritingCompactor: Compactor = {
      async compact(ctx) {
        ctx.state.replaceMessages([{ role: 'user', content: 'compacted' }]);
        return {
          before: 9_500,
          after: 100,
          fullRequestTokensBefore: 9_500,
          fullRequestTokensAfter: 100,
          reductions: [{ phase: 'summary', saved: 9_400 }],
        };
      },
    };
    const mw = new AutoCompactionMiddleware(rewritingCompactor, 10_000, simpleEstimator(9_500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.messages = [{ role: 'user', content: 'old' }];
    ctx.lastRequestTokens = 9_500;
    ctx.lastRealInputTokens = 9_000;
    ctx.meta['lastRequestTokensAt'] = { msgCount: 1, toolCount: 0, revision: 0 };
    ctx.meta['realAnchorMsgCount'] = 1;

    await mw.handler()(ctx, async (c) => c);

    expect(ctx.lastRequestTokens).toBeUndefined();
    expect(ctx.lastRealInputTokens).toBeUndefined();
    expect(ctx.meta['lastRequestTokensAt']).toBeUndefined();
    expect(ctx.meta['realAnchorMsgCount']).toBeUndefined();
  });

  it('drives the compaction decision from the REAL usage anchor over the estimator', () => {
    // The estimator says the context is tiny (100 tokens), but the provider's
    // real last-usage anchor says it is nearly full. The real number must win
    // so compaction fires — proving decisions run on real tokens, not the guess.
    const ctx = mockContext(0) as unknown as Context & {
      messages: unknown[];
      lastRealInputTokens?: number;
      meta: Record<string, unknown>;
    };
    ctx.messages = [{ role: 'user', content: 'q' }];
    ctx.lastRealInputTokens = 9_500; // real, from provider usage
    ctx.meta['realAnchorMsgCount'] = 1; // nothing appended since → delta 0

    const mw = new AutoCompactionMiddleware(compactor, 10_000, simpleEstimator(100), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    return mw
      .handler()(ctx as never as Context, async (c) => c)
      .then(() => {
        expect(compactor.compactCalls).toHaveLength(1);
        expect(compactor.compactCalls[0]?.aggressive).toBe(true); // hard → aggressive
      });
  });

  it('is a pass-through when disabled via setEnabled(false), even above hard threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    expect(mw.enabled).toBe(true);
    mw.setEnabled(false);
    expect(mw.enabled).toBe(false);

    const ctx = mockContext(0); // 95% load — would normally compact aggressively
    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true); // chain still advances
    expect(compactor.compactCalls).toHaveLength(0); // but no compaction fired

    // Re-enabling restores compaction on the next pass.
    mw.setEnabled(true);
    await mw.handler()(ctx, async (c) => c);
    expect(compactor.compactCalls).toHaveLength(1);
  });

  it('compacts non-aggressively at warn threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(5500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 55% load — between warn and soft
    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true);
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(false);
  });

  it('compacts aggressively at soft threshold by default', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(8000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 80% load — between soft and hard
    let _ran = false;
    await mw.handler()(ctx, async (c) => {
      _ran = true;
      return c;
    });

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(true); // aggressiveOn='soft' default
  });

  it('compacts aggressively at hard threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 95% load — above hard
    let _ran = false;
    await mw.handler()(ctx, async (c) => {
      _ran = true;
      return c;
    });

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(true);
  });

  it('uses a provider-overflow learned effective limit on the next pass', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 1_000_000, simpleEstimator(647_000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.meta['effectiveMaxContext'] = 655_000;

    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(true);
  });

  it('emits the budget snapshot used for compaction decisions', async () => {
    const events = new EventBus();
    const fired: unknown[] = [];
    events.on('compaction.fired', (e) => fired.push(e));
    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(9500),
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { events },
    );

    await mw.handler()(mockContext(0), async (c) => c);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      budget: {
        maxContext: 10000,
        inputTokens: 9500,
        reservedOutputTokens: 800,
        reservedSafetyTokens: 200,
        availableInputTokens: 9000,
        remainingInputTokens: -500,
        overflowTokens: 500,
      },
    });
  });

  it('uses repeated read pressure as an adaptive warn signal', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(4300), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    const ctx = mockContext(0);
    ctx.contextEvidence = createContextEvidenceState();
    ctx.contextEvidence.repeatedReads.push({ file: 'src/a.ts', count: 3, lastToolUseId: 'u3' });

    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(false);
  });

  it('respects aggressiveOn=hard setting', async () => {
    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(8000), // 80% load → soft band (between soft=75% and hard=90%)
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      'hard',
    );

    const ctx = mockContext(0); // 80% load: soft band, aggressiveOn=hard
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(false); // not aggressive until hard
  });

  it('throws compaction errors at hard threshold by default', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('compaction failed');
      },
    };
    const mw = new AutoCompactionMiddleware(badCompactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);
    let ran = false;
    await expect(
      mw.handler()(ctx, async (c) => {
        ran = true;
        return c;
      }),
    ).rejects.toThrow(/Auto-compaction failed/);

    expect(ran).toBe(false);
  });

  it('throws when hard compaction succeeds but remains above the hard threshold', async () => {
    const stuckCompactor: Compactor = {
      async compact() {
        return {
          before: 9500,
          after: 9500,
          fullRequestTokensBefore: 9500,
          fullRequestTokensAfter: 9500,
          reductions: [],
        };
      },
    };
    const events = new EventBus();
    const failures: Array<{ fatal: boolean; tokens: number; load: number }> = [];
    events.on('compaction.failed', (p) =>
      failures.push({ fatal: p.fatal, tokens: p.tokens, load: p.load }),
    );

    const mw = new AutoCompactionMiddleware(
      stuckCompactor,
      10000,
      simpleEstimator(9500),
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      { events },
    );

    let ran = false;
    await expect(
      mw.handler()(mockContext(0), async (c) => {
        ran = true;
        return c;
      }),
    ).rejects.toThrow(/did not reduce context below hard threshold/);

    expect(ran).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ fatal: true, tokens: 9500, load: 9500 / 9000 });
  });

  it('emergency-trims (instead of throwing) when compaction leaves trimmable content above hard', async () => {
    // A no-op compactor that never shrinks ctx.messages — the classic "preserveK
    // protects a single oversized message" case that used to throw
    // AGENT_CONTEXT_OVERFLOW. With the last-resort emergency trim, the middleware
    // must instead truncate the content until it fits, and continue the chain.
    const bigMsg = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400_000) }] };
    const messages: any[] = [bigMsg];
    const noopCompactor: Compactor = {
      async compact() {
        // Report the real full-request size so `stillHard` is genuinely true.
        return {
          before: 114_000,
          after: 114_000,
          fullRequestTokensBefore: 114_000,
          fullRequestTokensAfter: 114_000,
          reductions: [],
        };
      },
    };
    const events = new EventBus();
    const trims: Array<{ trimmedBlocks: number; withinBudget: boolean; load: number }> = [];
    const failures: unknown[] = [];
    events.on('compaction.emergency_trim', (p) =>
      trims.push({ trimmedBlocks: p.trimmedBlocks, withinBudget: p.withinBudget, load: p.load }),
    );
    events.on('compaction.failed', (p) => failures.push(p));

    const ctx = {
      messages,
      todos: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      systemPrompt: [],
      provider: { id: 'test', capabilities: { maxContext: 20_000 } } as any,
      session: { id: 's1' } as any,
      signal: new AbortController().signal,
      tokenCounter: {} as any,
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'test',
      tools: [],
      meta: {},
      clearFileTracking: () => {},
      state: {
        replaceMessages(next: any[]) {
          messages.length = 0;
          messages.push(...next);
        },
      },
    } as never as Context;

    // Default estimator (undefined) → the middleware measures ctx.messages itself.
    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      20_000,
      undefined,
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      { events },
    );

    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true); // chain advanced — NO throw
    expect(failures).toHaveLength(0);
    expect(trims).toHaveLength(1);
    expect(trims[0]?.withinBudget).toBe(true);
    expect(trims[0]?.load).toBeLessThan(0.9); // now under the hard line
  });

  it('target-trims toward policy targetLoad even below hard threshold', async () => {
    const bigMsg = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(120_000) }] };
    const messages: any[] = [bigMsg];
    const noopCompactor: Compactor = {
      async compact() {
        return {
          before: 34_000,
          after: 34_000,
          fullRequestTokensBefore: 34_000,
          fullRequestTokensAfter: 34_000,
          reductions: [],
        };
      },
    };
    const events = new EventBus();
    const targetTrims: Array<{ targetLoad: number; load: number; withinBudget: boolean }> = [];
    const emergencyTrims: unknown[] = [];
    events.on('compaction.target_trim', (p) =>
      targetTrims.push({ targetLoad: p.targetLoad, load: p.load, withinBudget: p.withinBudget }),
    );
    events.on('compaction.emergency_trim', (p) => emergencyTrims.push(p));

    const ctx = {
      messages,
      todos: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      systemPrompt: [],
      provider: { id: 'test', capabilities: { maxContext: 100_000 } } as any,
      session: { id: 's1' } as any,
      signal: new AbortController().signal,
      tokenCounter: {} as any,
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'test',
      tools: [],
      meta: {},
      clearFileTracking: () => {},
      state: {
        replaceMessages(next: any[]) {
          messages.length = 0;
          messages.push(...next);
        },
      },
    } as never as Context;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      100_000,
      undefined,
      { warn: 0.3, soft: 0.6, hard: 0.9 },
      {
        events,
        policyProvider: () => ({
          thresholds: { warn: 0.3, soft: 0.6, hard: 0.9 },
          aggressiveOn: 'soft',
          targetLoad: 0.35,
        }),
      },
    );

    await mw.handler()(ctx, async (c) => c);

    expect(targetTrims).toHaveLength(1);
    expect(targetTrims[0]?.targetLoad).toBe(0.35);
    expect(targetTrims[0]?.withinBudget).toBe(true);
    expect(targetTrims[0]?.load).toBeLessThan(0.9);
    expect(emergencyTrims).toHaveLength(0);
  });

  it('can continue when hard compaction remains above the hard threshold if configured', async () => {
    const stuckCompactor: Compactor = {
      async compact() {
        return {
          before: 9500,
          after: 9500,
          fullRequestTokensBefore: 9500,
          fullRequestTokensAfter: 9500,
          reductions: [],
        };
      },
    };
    const events = new EventBus();
    const failures: Array<{ fatal: boolean }> = [];
    events.on('compaction.failed', (p) => failures.push({ fatal: p.fatal }));

    const mw = new AutoCompactionMiddleware(
      stuckCompactor,
      10000,
      simpleEstimator(9500),
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      { events, failureMode: 'continue' },
    );

    let ran = false;
    await mw.handler()(mockContext(0), async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true);
    expect(failures).toEqual([{ fatal: false }]);
  });

  it('uses custom estimator', async () => {
    const estimator = vi.fn(() => 9500);
    const mw = new AutoCompactionMiddleware(compactor, 10000, estimator, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);
    await mw.handler()(ctx, async (c) => c);

    expect(estimator).toHaveBeenCalledWith(ctx);
    expect(compactor.compactCalls).toHaveLength(1);
  });

  it('uses a runtime policy provider for thresholds and aggressiveness', async () => {
    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(5000),
      {
        warn: 0.7,
        soft: 0.85,
        hard: 0.95,
      },
      {
        policyProvider: () => ({
          thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
          aggressiveOn: 'warn',
          targetLoad: 0.5,
        }),
      },
    );

    await mw.handler()(mockContext(0), async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0]!.aggressive).toBe(true);
  });

  it('emits compaction.failed when the compactor throws and an EventBus is wired', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('summarizer model unavailable');
      },
    };
    const events = new EventBus();
    const failures: Array<{
      err: Error;
      aggressive: boolean;
      level: 'warn' | 'soft' | 'hard';
      fatal: boolean;
    }> = [];
    events.on('compaction.failed', (p) => failures.push(p));

    const mw = new AutoCompactionMiddleware(
      badCompactor,
      10000,
      simpleEstimator(9500), // hard load → aggressive
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { aggressiveOn: 'soft', events },
    );

    let ran = false;
    await expect(
      mw.handler()(mockContext(0), async (c) => {
        ran = true;
        return c;
      }),
    ).rejects.toThrow(/Auto-compaction failed/);
    expect(ran).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.err.message).toBe('summarizer model unavailable');
    expect(failures[0]!.aggressive).toBe(true);
    expect(failures[0]!.level).toBe('hard');
    expect(failures[0]!.fatal).toBe(true);
  });

  it('does not re-run compaction after a no-op attempt at the same pressure level', async () => {
    // Compactor that reports zero savings — simulates preserveK protecting
    // everything and no oversized tool_results outside the window.
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return {
          before: 1000,
          after: 1000,
          fullRequestTokensBefore: 1000,
          fullRequestTokensAfter: 1000,
          reductions: [],
        };
      },
    };
    const events = new EventBus();
    const fired: unknown[] = [];
    events.on('compaction.fired', (e) => fired.push(e));

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      simpleEstimator(8000), // 80% load → soft band (above warn=50%)
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { aggressiveOn: 'soft', events, failureMode: 'continue' },
    );

    // Three back-to-back iterations at the same pressure with no change
    for (let i = 0; i < 3; i++) {
      await mw.handler()(mockContext(0), async (c) => c);
    }

    // First attempt fires; subsequent no-op-at-same-level attempts are skipped.
    expect(noopCompactor.calls).toBe(1);
    expect(fired).toHaveLength(1);
  });

  it('treats a negligible positive reduction as a no-op and backs off', async () => {
    const tinyCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return {
          before: 459_607,
          after: 459_253,
          fullRequestTokensBefore: 459_607,
          fullRequestTokensAfter: 459_253,
          reductions: [],
        };
      },
    };
    const mw = new AutoCompactionMiddleware(
      tinyCompactor,
      1_000_000,
      simpleEstimator(600_000),
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c);
    await mw.handler()(mockContext(0), async (c) => c);

    expect(tinyCompactor.calls).toBe(1);
  });

  it('retries compaction after a no-op when context grows materially', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return {
          before: 1000,
          after: 1000,
          fullRequestTokensBefore: 1000,
          fullRequestTokensAfter: 1000,
          reductions: [],
        };
      },
    };
    let currentRaw = 8000;
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // initial no-op records stuck state
    expect(noopCompactor.calls).toBe(1);

    // Tiny growth — still skipped
    currentRaw = 8050;
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(1);

    // Large growth — escalates from soft (8000=80%) to hard (10000=100%) → retries
    currentRaw = 10000;
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('retries compaction after a no-op when pressure escalates to a higher level', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return {
          before: 1000,
          after: 1000,
          fullRequestTokensBefore: 1000,
          fullRequestTokensAfter: 1000,
          reductions: [],
        };
      },
    };
    let currentRaw = 7800; // 78% load → soft band (above soft=75%, below hard=90%)
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // no-op at soft
    await mw.handler()(mockContext(0), async (c) => c); // skipped
    expect(noopCompactor.calls).toBe(1);

    currentRaw = 9200; // 92% load → escalates to hard
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('clears the no-op record when load drops back below all thresholds', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return {
          before: 1000,
          after: 1000,
          fullRequestTokensBefore: 1000,
          fullRequestTokensAfter: 1000,
          reductions: [],
        };
      },
    };
    let currentRaw = 8000;
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // no-op
    currentRaw = 3000; // 30% load → below warn
    await mw.handler()(mockContext(0), async (c) => c);
    currentRaw = 8000; // back up — stuck state cleared, should retry
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('can be configured to continue after compaction errors', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('boom');
      },
    };
    const mw = new AutoCompactionMiddleware(
      badCompactor,
      10000,
      simpleEstimator(9500),
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      { failureMode: 'continue' },
    );
    let ran = false;
    await mw.handler()(mockContext(0), async (c) => {
      ran = true;
      return c;
    });
    expect(ran).toBe(true);
  });

  it('writes compaction event to the provided SessionEventBridge on successful compaction', async () => {
    const append = vi.fn();
    const mockBridge: SessionEventBridge = {
      append,
      level: 'standard',
      allows: () => true,
    };

    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(9500), // hard load → will trigger compaction
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      {
        aggressiveOn: 'soft',
        sessionBridge: mockBridge,
      },
    );

    const ctx = mockContext(0);
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(1);

    const event = append.mock.calls[0]![0];
    expect(event.type).toBe('compaction');
    expect(event.before).toBe(1000);
    expect(event.after).toBe(800);
    expect(event.level).toBe('hard');
    expect(typeof event.ts).toBe('string');
  });

  it('calls the custom estimator on every invocation (no caching for custom estimators)', async () => {
    // Custom estimators own their own semantics — the middleware must NOT
    // cache their result. Each handler() call invokes the estimator fresh.
    let estimatorCalls = 0;
    const countingEstimator = () => {
      estimatorCalls++;
      return 3000; // 30% load — below all thresholds
    };

    const mw = new AutoCompactionMiddleware(compactor, 10000, countingEstimator, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);

    // Three back-to-back calls with identical context — estimator called every time.
    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(1);

    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(2);

    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(3);
  });

  it('calls the custom estimator fresh when context changes', async () => {
    let estimatorCalls = 0;
    const countingEstimator = () => {
      estimatorCalls++;
      return 3000;
    };

    const mw = new AutoCompactionMiddleware(compactor, 10000, countingEstimator, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    // First call
    const ctx1 = mockContext(0);
    await mw.handler()(ctx1, async (c) => c);
    expect(estimatorCalls).toBe(1);

    // Same context — custom estimators are never cached, called again
    await mw.handler()(ctx1, async (c) => c);
    expect(estimatorCalls).toBe(2);

    // DIFFERENT context — called again
    const ctx2 = mockContext(0);
    ctx2.messages = [{ role: 'user', content: 'new message' } as any];
    await mw.handler()(ctx2, async (c) => c);
    expect(estimatorCalls).toBe(3);

    // Same context again — still called fresh
    await mw.handler()(ctx2, async (c) => c);
    expect(estimatorCalls).toBe(4);
  });
});
