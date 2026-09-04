import { describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  type BrainRuntimeLedgerHost,
  type BrainRuntimeOptions,
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from '../../src/execution/brain-runtime.js';
import type { BrainConfig } from '../../src/types/config.js';
import type { Provider } from '../../src/types/provider.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'system',
  question: 'Should we continue?',
  risk: 'medium',
  fallback: 'ask_human',
  ...over,
});

function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as never as Provider;
}

function baseOpts(
  initialConfig: BrainConfig | undefined,
  over: Partial<BrainRuntimeOptions> = {},
): BrainRuntimeOptions {
  return {
    initialConfig,
    defaultProviderId: 'session-prov',
    sessionProvider: () => fakeProvider('session says: Continue.'),
    sessionModel: () => 'session-model',
    resolveProvider: () => fakeProvider('pool says: Continue.'),
    ...over,
  };
}

describe('createBrainRuntime', () => {
  it('starts on the session model and switches to a new pool via apply() without replacing the arbiter handle', async () => {
    const session = fakeProvider('Continue execution.');
    const poolProvider = fakeProvider('Pool model answer: continue.');
    const resolveProvider = vi.fn(() => poolProvider);
    const rt = createBrainRuntime(
      baseOpts(undefined, { sessionProvider: () => session, resolveProvider }),
    );
    const arbiterBefore = rt.arbiter;

    expect(rt.getSnapshot().usingSessionModel).toBe(true);
    await rt.arbiter.decide(req());
    expect(session.complete).toHaveBeenCalled();

    const { snapshot } = rt.apply({ models: ['prov-a/model-a'] }, { persist: false });
    expect(rt.arbiter).toBe(arbiterBefore);
    expect(snapshot.usingSessionModel).toBe(false);
    expect(snapshot.poolLabels).toEqual(['prov-a/model-a']);

    await rt.arbiter.decide(req({ id: 'r2' }));
    expect(poolProvider.complete).toHaveBeenCalled();
  });

  it('exposes the effective council judge in the snapshot and clears it with the council', () => {
    const rt = createBrainRuntime(baseOpts(undefined));
    expect(rt.getSnapshot().judgeLabel).toBeUndefined();

    // 4 models → 3 derived seats + one target left over to judge independently.
    const seated = rt.apply({ models: ['a/x', 'b/y', 'c/z', 'd/w'] }, { persist: false });
    expect(seated.snapshot.councilLabels).toHaveLength(3);
    expect(seated.snapshot.judgeLabel).toBe('d/w');

    // Dropping below two voters disbands the council; the judge goes with it.
    const disbanded = rt.apply({ models: ['a/x'] }, { persist: false });
    expect(disbanded.snapshot.councilLabels).toEqual([]);
    expect(disbanded.snapshot.judgeLabel).toBeUndefined();
  });

  it('defaults llm.denyIsTerminal to when-decided so a real refusal can stand', () => {
    // With 'never' the LLM tier could agree but never disagree: every deny was
    // discarded, which made the refused/unavailable/unparseable distinction
    // (`readLlmDenyKind`) unreachable in the shipped product.
    const rt = createBrainRuntime(baseOpts(undefined));
    expect(rt.getSnapshot().llm.denyIsTerminal).toBe('when-decided');
  });

  it('lets an explicit denyIsTerminal override the product default', () => {
    const rt = createBrainRuntime(baseOpts({ llm: { denyIsTerminal: 'never' } }));
    expect(rt.getSnapshot().llm.denyIsTerminal).toBe('never');
    const { snapshot } = rt.apply({ llm: { denyIsTerminal: 'always' } }, { persist: false });
    expect(snapshot.llm.denyIsTerminal).toBe('always');
    // …and it must survive the wholesale getConfig() persist (see the
    // brain-config-roundtrip guard).
    expect(rt.getConfig().llm?.denyIsTerminal).toBe('always');
  });

  it('normalizes string refs and reports resolved pool labels', () => {
    const rt = createBrainRuntime(baseOpts(undefined));
    const { snapshot } = rt.apply(
      { models: ['prov-a/model-a', 'bare-model', { provider: 'prov-b', model: 'model-b' }] },
      { persist: false },
    );
    expect(snapshot.models).toEqual([
      { provider: 'prov-a', model: 'model-a' },
      { model: 'bare-model' },
      { provider: 'prov-b', model: 'model-b' },
    ]);
    expect(snapshot.poolLabels).toEqual([
      'prov-a/model-a',
      'session-prov/bare-model',
      'prov-b/model-b',
    ]);
  });

  it('rejects invalid patches atomically (state unchanged, error thrown)', () => {
    const rt = createBrainRuntime(baseOpts({ maxAutoRisk: 'high' }));
    expect(() => rt.apply({ models: ['   '] }, { persist: false })).toThrow(/Invalid model ref/);
    expect(() => rt.apply({ council: { quorum: 3 } }, { persist: false })).toThrow(/quorum/);
    expect(() => rt.apply({ maxAutoRisk: 'extreme' as never }, { persist: false })).toThrow(
      /Invalid maxAutoRisk/,
    );
    const snap = rt.getSnapshot();
    expect(snap.maxAutoRisk).toBe('high');
    expect(snap.models).toEqual([]);
  });

  it('council convenes/dissolves via apply and snapshot reports EFFECTIVE enablement', () => {
    const rt = createBrainRuntime(baseOpts(undefined));
    expect(rt.getSnapshot().council.enabled).toBe(false);

    // 2+ pool models → council auto-derives.
    let snap = rt.apply({ models: ['a/x', 'b/y'] }, { persist: false }).snapshot;
    expect(snap.council.enabled).toBe(true);
    expect(snap.council.configured).toBeUndefined();
    expect(snap.councilLabels).toEqual(['a/x (executor)', 'b/y (skeptic, veto)']);

    // Explicit disable pins it off despite the pool.
    snap = rt.apply({ council: { enabled: false } }, { persist: false }).snapshot;
    expect(snap.council.enabled).toBe(false);
    expect(snap.council.configured).toBe(false);

    // Explicit voters with persona/veto/weight survive normalization.
    snap = rt.apply(
      {
        council: {
          enabled: true,
          voters: ['a/x', { provider: 'b', model: 'y', persona: 'auditor', veto: true, weight: 2 }],
          minRisk: 'medium',
        },
      },
      { persist: false },
    ).snapshot;
    expect(snap.council.enabled).toBe(true);
    expect(snap.council.minRisk).toBe('medium');
    expect(snap.council.voters[1]).toEqual({
      provider: 'b',
      model: 'y',
      persona: 'auditor',
      veto: true,
      weight: 2,
    });
  });

  it('fast-path keys (mode/maxAutoRisk/humanTimeoutMs) do not rebuild the chain', () => {
    const resolveProvider = vi.fn(() => fakeProvider('p'));
    const rt = createBrainRuntime(baseOpts({ models: ['a/x'] }, { resolveProvider }));
    const callsAfterBoot = resolveProvider.mock.calls.length;
    expect(callsAfterBoot).toBeGreaterThan(0);

    rt.apply({ mode: 'headless' }, { persist: false });
    rt.apply({ maxAutoRisk: 'all' }, { persist: false });
    rt.apply({ humanTimeoutMs: 60_000 }, { persist: false });
    expect(resolveProvider.mock.calls.length).toBe(callsAfterBoot);
    expect(rt.getMode()).toBe('headless');
    expect(rt.getMaxAutoRisk()).toBe('all');
    expect(rt.getHumanTimeoutMs()).toBe(60_000);

    // A structural key DOES rebuild.
    rt.apply({ strategy: 'round-robin' }, { persist: false });
    expect(resolveProvider.mock.calls.length).toBeGreaterThan(callsAfterBoot);
  });

  it('persists the canonical compact config by default and reports persist failures without rollback', async () => {
    const persist = vi.fn(async () => {});
    const rt = createBrainRuntime(baseOpts(undefined, { persist }));

    const { persisted } = rt.apply({
      models: ['prov-a/model-a', 'bare-model'],
      council: { voters: [{ provider: 'b', model: 'y', veto: true }], judge: 'prov-a/model-a' },
      decisionTimeoutMs: 20_000,
    });
    expect(await persisted).toEqual({ ok: true });
    expect(persist).toHaveBeenCalledTimes(1);
    const written = persist.mock.calls[0]?.[0] as BrainConfig;
    expect(written.models).toEqual(['prov-a/model-a', 'bare-model']);
    expect(written.council?.voters).toEqual([{ provider: 'b', model: 'y', veto: true }]);
    expect(written.council?.judge).toBe('prov-a/model-a');
    expect(written.decisionTimeoutMs).toBe(20_000);

    persist.mockRejectedValueOnce(new Error('disk full'));
    const second = rt.apply({ maxAutoRisk: 'high' });
    expect(await second.persisted).toEqual({ ok: false, error: 'disk full' });
    // Live state kept despite persist failure.
    expect(rt.getMaxAutoRisk()).toBe('high');
  });

  it('skips persistence when persist:false or no callback is wired', async () => {
    const persist = vi.fn(async () => {});
    const rt = createBrainRuntime(baseOpts(undefined, { persist }));
    expect(await rt.apply({ mode: 'headless' }, { persist: false }).persisted).toEqual({
      ok: true,
    });
    expect(persist).not.toHaveBeenCalled();

    const noCb = createBrainRuntime(baseOpts(undefined));
    expect(await noCb.apply({ mode: 'headless' }).persisted).toEqual({ ok: true });
  });

  it('gates ledger guard and digest injection on the host ledger enablement', async () => {
    let enabled = true;
    const digest = vi.fn(() => 'past outcomes digest');
    const ledger: BrainRuntimeLedgerHost = {
      getPath: () => 'C:/tmp/brain-ledger.jsonl',
      isEnabled: () => enabled,
      setEnabled: vi.fn((on: boolean) => {
        enabled = on;
      }),
      failureStreakFor: () => 5,
      getDecisionDigest: digest,
    };
    const rt = createBrainRuntime(baseOpts({ ledger: { autoDenyAfterFailures: 3 } }, { ledger }));

    // Streak 5 >= denyAfter 3 → deterministic deny, no LLM.
    const denied = await rt.arbiter.decide(req());
    expect(denied).toMatchObject({ type: 'deny' });
    expect((denied as { reason: string }).reason).toMatch(/Ledger guard/);

    // Disable via apply → host toggled, guard dropped from the chain.
    const { snapshot } = rt.apply({ ledger: { enabled: false } }, { persist: false });
    expect(ledger.setEnabled).toHaveBeenCalledWith(false);
    expect(snapshot.ledger.enabled).toBe(false);
    const after = await rt.arbiter.decide(
      req({ id: 'r3', fallback: 'continue', question: 'plain continue?' }),
    );
    expect(after.type).not.toBe('deny');
  });

  it('onApplied fires with the fresh snapshot after every apply', () => {
    const onApplied = vi.fn();
    const rt = createBrainRuntime(baseOpts(undefined, { onApplied }));
    rt.apply({ humanTimeoutMs: 5_000 }, { persist: false });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]?.[0]).toMatchObject({ humanTimeoutMs: 5_000 });
  });

  it('drops invalid boot-config entries leniently instead of failing construction', () => {
    const rt = createBrainRuntime(
      baseOpts({
        models: ['good/x', '   ', { model: '' } as never],
        council: { judge: '  ' },
      }),
    );
    const snap = rt.getSnapshot();
    expect(snap.models).toEqual([{ provider: 'good', model: 'x' }]);
    expect(snap.council.judge).toBeUndefined();
  });
});

describe('resolveBrainConfigDefaults', () => {
  it('fills minimum-human defaults on an empty config (no pool → conservative ceiling)', () => {
    const cfg = resolveBrainConfigDefaults(undefined);
    expect(cfg.mode).toBe('headless');
    expect(cfg.maxAutoRisk).toBe('high');
    expect(cfg.humanTimeoutMs).toBe(120_000);
    expect(cfg.models).toBeUndefined();
  });

  it('seeds the pool from fallbackModels and raises the ceiling when a council can convene', () => {
    const cfg = resolveBrainConfigDefaults(undefined, {
      fallbackModels: ['prov-a/model-a', 'prov-b/model-b'],
    });
    expect(cfg.models).toEqual(['prov-a/model-a', 'prov-b/model-b']);
    // 2 pool models → council auto-derives → critical goes to the panel.
    expect(cfg.maxAutoRisk).toBe('all');
  });

  it('keeps the ceiling at high with a single fallback model (no council possible)', () => {
    const cfg = resolveBrainConfigDefaults(undefined, { fallbackModels: ['prov-a/model-a'] });
    expect(cfg.models).toEqual(['prov-a/model-a']);
    expect(cfg.maxAutoRisk).toBe('high');
  });

  it('never overrides explicit values', () => {
    const cfg = resolveBrainConfigDefaults(
      {
        mode: 'interactive',
        maxAutoRisk: 'medium',
        models: [],
        humanTimeoutMs: 0,
      },
      { fallbackModels: ['prov-a/model-a', 'prov-b/model-b'] },
    );
    expect(cfg.mode).toBe('interactive');
    expect(cfg.maxAutoRisk).toBe('medium');
    // Explicit empty pool is respected (session model), not reseeded.
    expect(cfg.models).toEqual([]);
    // Explicit 0 = legacy wait-indefinitely escape hatch.
    expect(cfg.humanTimeoutMs).toBe(0);
  });

  it('respects explicit council toggles when picking the adaptive ceiling', () => {
    // Big pool but council pinned OFF → conservative ceiling.
    const off = resolveBrainConfigDefaults(
      { council: { enabled: false } },
      { fallbackModels: ['a/x', 'b/y', 'c/z'] },
    );
    expect(off.maxAutoRisk).toBe('high');
    // No pool but explicit voters → council convenes → full ceiling.
    const voters = resolveBrainConfigDefaults({
      council: { voters: ['a/x', 'b/y'] },
    });
    expect(voters.maxAutoRisk).toBe('all');
  });

  it('feeds createBrainRuntime: fallback-seeded pool resolves and derives the council', () => {
    const resolveProvider = vi.fn(() => fakeProvider('ok'));
    const rt = createBrainRuntime(
      baseOpts(
        resolveBrainConfigDefaults(undefined, {
          fallbackModels: ['prov-a/model-a', 'prov-b/model-b'],
        }),
        { resolveProvider },
      ),
    );
    const snap = rt.getSnapshot();
    expect(snap.mode).toBe('headless');
    expect(snap.maxAutoRisk).toBe('all');
    expect(snap.poolLabels).toEqual(['prov-a/model-a', 'prov-b/model-b']);
    expect(snap.council.enabled).toBe(true);
    expect(snap.councilLabels).toEqual([
      'prov-a/model-a (executor)',
      'prov-b/model-b (skeptic, veto)',
    ]);
  });
});

describe('createBrainRuntime — deterministic rules', () => {
  it('lets a rule settle the request without touching the LLM tier', async () => {
    const session = fakeProvider('Continue execution.');
    const rt = createBrainRuntime(
      baseOpts(
        {
          rules: [
            {
              id: 'monitor-observe',
              when: { source: 'system', offersOption: 'continue' },
              then: { action: 'answer', optionId: 'continue' },
            },
          ],
        },
        { sessionProvider: () => session },
      ),
    );

    const decision = await rt.arbiter.decide(
      req({
        options: [
          { id: 'steer', label: 'Steer', recommended: true },
          { id: 'continue', label: 'Let it continue' },
        ],
      }),
    );

    expect(decision).toMatchObject({ type: 'answer', optionId: 'continue' });
    expect(session.complete).not.toHaveBeenCalled();
  });

  it('falls through to the normal chain when no rule matches', async () => {
    const session = fakeProvider('Continue execution.');
    const rt = createBrainRuntime(
      baseOpts(
        {
          maxAutoRisk: 'all',
          rules: [{ id: 'tools-only', when: { source: 'tool' }, then: { action: 'deny' } }],
        },
        { sessionProvider: () => session },
      ),
    );

    await rt.arbiter.decide(req());
    expect(session.complete).toHaveBeenCalled();
  });

  it('exposes rules and compile diagnostics on the snapshot', () => {
    const rt = createBrainRuntime(
      baseOpts({
        rules: [
          { id: 'ok', when: { question: 'continue' }, then: { action: 'answer', text: 'yes' } },
          { id: 'broken', when: { question: '(' }, then: { action: 'answer', text: 'no' } },
        ],
      }),
    );

    const snap = rt.getSnapshot();
    expect(snap.rules.map((r) => r.id)).toEqual(['ok', 'broken']);
    // A bad pattern disables only its own rule, and stays visible.
    expect(snap.ruleErrors).toHaveLength(1);
    expect(snap.ruleErrors[0]).toContain('broken');
  });

  it('rejects an invalid rule table on apply() instead of silently dropping rules', () => {
    const rt = createBrainRuntime(baseOpts(undefined));
    expect(() =>
      rt.apply(
        { rules: [{ id: 'bad', when: { question: '(' }, then: { action: 'answer', text: 'x' } }] },
        { persist: false },
      ),
    ).toThrow(/Invalid Brain rule/);
  });

  it('clears the table with null and round-trips through getConfig', () => {
    const rt = createBrainRuntime(
      baseOpts({
        rules: [{ id: 'keep', when: {}, then: { action: 'answer', text: 'yes' } }],
      }),
    );
    expect(rt.getConfig().rules).toHaveLength(1);

    rt.apply({ rules: null }, { persist: false });
    expect(rt.getConfig().rules).toBeUndefined();
    expect(rt.getSnapshot().rules).toEqual([]);
  });
});

describe('createBrainRuntime — heuristic toggles', () => {
  // Deliberately avoids the words "continue"/"proceed": the separate
  // continue-ping heuristic would otherwise answer first and mask whether the
  // blocked-resolved toggle had any effect.
  const blockedResolved = req({
    question: 'The task is blocked. Resume it?',
    context: 'The upstream PR was merged.',
    fallback: 'continue',
    risk: 'low',
  });

  it('answers via the blocked-resolved heuristic by default', async () => {
    const session = fakeProvider('LLM answer');
    const rt = createBrainRuntime(baseOpts(undefined, { sessionProvider: () => session }));
    const decision = await rt.arbiter.decide(blockedResolved);
    expect(decision).toMatchObject({ type: 'answer' });
    expect(session.complete).not.toHaveBeenCalled();
  });

  it('stops guessing once the heuristic is turned off', async () => {
    const session = fakeProvider('LLM answer');
    const rt = createBrainRuntime(
      baseOpts(
        { maxAutoRisk: 'all', heuristics: { blockedResolved: false } },
        { sessionProvider: () => session },
      ),
    );
    await rt.arbiter.decide(blockedResolved);
    // With the free guess disabled the question has to reach a real model.
    expect(session.complete).toHaveBeenCalled();
  });

  it('honours a custom resolution vocabulary', async () => {
    const session = fakeProvider('LLM answer');
    const rt = createBrainRuntime(
      baseOpts(
        { maxAutoRisk: 'all', heuristics: { blockedResolvedMarkers: ['yayinlandi'] } },
        { sessionProvider: () => session },
      ),
    );
    const complete = session.complete as unknown as ReturnType<typeof vi.fn>;

    // Replacing the list REPLACES it — the built-in "merged" marker no longer
    // counts as evidence, so the question has to reach a model.
    await rt.arbiter.decide(blockedResolved);
    expect(complete).toHaveBeenCalled();

    complete.mockClear();
    const decision = await rt.arbiter.decide(
      req({
        question: 'The task is blocked. Resume it?',
        context: 'Paket yayinlandi.',
        fallback: 'continue',
        risk: 'low',
      }),
    );
    expect(decision).toMatchObject({ type: 'answer' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('disables the low-risk fast path when asked', async () => {
    const lowRisk = req({
      risk: 'low',
      fallback: 'deny',
      options: [{ id: 'go', label: 'Go', recommended: true }],
    });

    const on = createBrainRuntime(baseOpts(undefined));
    expect(await on.arbiter.decide(lowRisk)).toMatchObject({ type: 'answer', optionId: 'go' });

    const off = createBrainRuntime(baseOpts({ heuristics: { lowRiskAutoAnswer: false } }));
    expect(await off.arbiter.decide(lowRisk)).toMatchObject({ type: 'deny' });
  });

  it('reports effective toggles on the snapshot and round-trips through getConfig', () => {
    const rt = createBrainRuntime(baseOpts({ heuristics: { continuePing: false } }));
    expect(rt.getSnapshot().heuristics).toMatchObject({
      continuePing: false,
      deadlockSkip: true,
      lowRiskAutoAnswer: true,
    });

    rt.apply({ heuristics: { deadlockSkip: false } }, { persist: false });
    // Sub-patches MERGE — the earlier toggle must survive.
    expect(rt.getConfig().heuristics).toEqual({ continuePing: false, deadlockSkip: false });

    rt.apply({ heuristics: null }, { persist: false });
    expect(rt.getConfig().heuristics).toBeUndefined();
    expect(rt.getSnapshot().heuristics.continuePing).toBe(true);
  });

  it('rejects a non-boolean toggle', () => {
    const rt = createBrainRuntime(baseOpts(undefined));
    expect(() =>
      rt.apply({ heuristics: { deadlockSkip: 'yes' as never } }, { persist: false }),
    ).toThrow(/expected a boolean/);
  });
});

describe('createBrainRuntime — config round-trip (brain-config-roundtrip)', () => {
  // `apply()` persists getConfig() WHOLESALE. Any BrainConfig field that
  // getConfig() forgets to copy is silently deleted from the user's config
  // the next time they change any Brain setting. This asserts the property
  // for EVERY top-level key rather than for a hand-listed few, so a field
  // added later fails here instead of eating someone's config.
  const fullConfig: BrainConfig = {
    mode: 'interactive',
    maxAutoRisk: 'high',
    models: ['prov-a/model-a'],
    strategy: 'round-robin',
    decisionTimeoutMs: 9_000,
    humanTimeoutMs: 45_000,
    rules: [{ id: 'r1', when: { source: 'tool' }, then: { action: 'deny' } }],
    heuristics: { continuePing: false },
    llm: { maxTokens: 512, rejectUncertain: false, minConfidence: 0.4 },
    trace: { enabled: true, content: 'redacted', maxOpenRecords: 50 },
    council: {
      enabled: true,
      minRisk: 'critical',
      quorum: 0.6,
      perCallTimeoutMs: 20_000,
      maxConcurrency: 5,
      distinctness: 'provider',
      voterMaxTokens: 1500,
      judgeMaxTokens: 400,
      deliberationRounds: 3,
      seats: [{ persona: 'security', veto: true }],
    },
    ledger: {
      enabled: true,
      autoDenyAfterFailures: 5,
      maxMemoryEntries: 100,
      interventionRetryWindowMs: 90_000,
    },
    monitor: { policy: 'observe', stallCheckIntervalMs: 10_000 },
    terminalPolicy: 'deny-all',
    decisionLogMaxEntries: 40,
    cache: { enabled: true, ttlMs: 60_000, maxEntries: 25 },
  };

  it('preserves every configured top-level field through getConfig()', () => {
    const rt = createBrainRuntime(baseOpts(fullConfig));
    const out = rt.getConfig();
    for (const key of Object.keys(fullConfig)) {
      expect(out, `getConfig() dropped "${key}"`).toHaveProperty(key);
    }
  });

  it('preserves NESTED council/ledger fields too', () => {
    // getConfig() rebuilds `council` field-by-field rather than spreading it,
    // so a newly added sub-field is dropped exactly like a top-level one.
    const rt = createBrainRuntime(baseOpts(fullConfig));
    const out = rt.getConfig();
    for (const key of Object.keys(fullConfig.council ?? {})) {
      expect(out.council, `getConfig() dropped "council.${key}"`).toHaveProperty(key);
    }
    for (const key of Object.keys(fullConfig.ledger ?? {})) {
      expect(out.ledger, `getConfig() dropped "ledger.${key}"`).toHaveProperty(key);
    }
  });

  it('does not lose boot-only blocks when an unrelated setting is applied', () => {
    const rt = createBrainRuntime(baseOpts(fullConfig));
    rt.apply({ maxAutoRisk: 'low' }, { persist: false });

    const out = rt.getConfig();
    expect(out.maxAutoRisk).toBe('low');
    // `trace` and `llm` have no patch surface yet — changing something else
    // must not erase them.
    expect(out.trace).toEqual(fullConfig.trace);
    expect(out.llm).toEqual(fullConfig.llm);
    expect(out.monitor).toEqual(fullConfig.monitor);
  });

  it('writes the same object it would persist', async () => {
    const persisted: BrainConfig[] = [];
    const rt = createBrainRuntime(
      baseOpts(fullConfig, {
        persist: async (config) => {
          persisted.push(config);
        },
      }),
    );
    await rt.apply({ mode: 'headless' }).persisted;

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.trace).toEqual(fullConfig.trace);
    expect(persisted[0]?.llm).toEqual(fullConfig.llm);
  });
});
