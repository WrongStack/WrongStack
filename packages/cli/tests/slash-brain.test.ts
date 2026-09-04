import type { BrainArbiter, BrainDecisionRequest } from '@wrongstack/core/coordination';
import type {
  BrainConfigPatch,
  BrainConfigSnapshot,
  BrainRuntime,
} from '@wrongstack/core/execution';
import { describe, expect, it, vi } from 'vitest';
import { buildBrainCommand } from '../src/slash-commands/brain.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

// Strip ANSI escapes so message assertions match regardless of color.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const makeCtx = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never as SlashCommandContext['renderer'],
    ...overrides,
  } as never as SlashCommandContext;
};

describe('/brain slash command', () => {
  it('reports name, category and help text', () => {
    const cmd = buildBrainCommand(makeCtx());
    expect(cmd.name).toBe('brain');
    expect(cmd.category).toBe('Agent');
    expect(cmd.help).toContain('/brain risk');
    expect(cmd.help).toContain('/brain ask');
  });

  describe('status', () => {
    it('shows the current ceiling and an empty-log hint', async () => {
      const ctx = makeCtx({
        brainSettings: { maxAutoRisk: 'medium' },
        getBrainLog: () => [],
      });
      const result = await buildBrainCommand(ctx).run!('');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('autonomy ceiling: medium');
      expect(message).toContain('no decisions recorded');
    });

    it('lists recent decisions newest-last', async () => {
      const now = Date.now();
      const ctx = makeCtx({
        brainSettings: { maxAutoRisk: 'high' },
        getBrainLog: () => [
          { at: now - 5_000, kind: 'answered', question: 'Continue phase 2?', outcome: 'continue' },
          {
            at: now - 1_000,
            kind: 'intervention',
            question: 'Tool edit failing',
            outcome: 'steered the agent',
          },
        ],
      });
      const result = await buildBrainCommand(ctx).run!('status');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('recent decisions (2)');
      expect(message).toContain('Continue phase 2?');
      expect(message).toContain('steered the agent');
    });
  });

  describe('risk', () => {
    it('shows the current ceiling when no level is given', async () => {
      const ctx = makeCtx({ brainSettings: { maxAutoRisk: 'low' } });
      const result = await buildBrainCommand(ctx).run!('risk');
      expect(stripAnsi(result!.message!)).toContain('Brain autonomy ceiling: low');
    });

    it.each(['off', 'low', 'medium', 'high', 'all'] as const)(
      'sets the ceiling to %s in place',
      async (level) => {
        const settings = { maxAutoRisk: 'medium' as const } as { maxAutoRisk: string };
        const ctx = makeCtx({
          brainSettings: settings as SlashCommandContext['brainSettings'],
        });
        const result = await buildBrainCommand(ctx).run!(`risk ${level}`);
        expect(settings.maxAutoRisk).toBe(level);
        expect(stripAnsi(result!.message!)).toContain(`set to ${level}`);
      },
    );

    it('rejects unknown levels without mutating settings', async () => {
      const settings = { maxAutoRisk: 'medium' as const };
      const ctx = makeCtx({ brainSettings: settings });
      const result = await buildBrainCommand(ctx).run!('risk extreme');
      expect(settings.maxAutoRisk).toBe('medium');
      expect(result?.message).toMatch(/Unknown risk level/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
    });

    it('warns when brainSettings is not wired', async () => {
      const ctx = makeCtx();
      const result = await buildBrainCommand(ctx).run!('risk high');
      expect(result?.message).toMatch(/not available/);
    });
  });

  describe('ask', () => {
    it('consults the brain and returns its answer', async () => {
      const decide = vi.fn(async () => ({
        type: 'answer' as const,
        text: 'Ship it.',
        rationale: 'Tests pass and scope is small.',
      }));
      const ctx = makeCtx({ brain: { decide } as BrainArbiter });
      const result = await buildBrainCommand(ctx).run!('ask should we ship?');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('Ship it.');
      expect(message).toContain('Tests pass and scope is small.');
      const request = (decide.mock.calls as unknown[][])[0]?.[0] as unknown as BrainDecisionRequest;
      expect(request.source).toBe('user');
      expect(request.question).toBe('should we ship?');
      expect(request.fallback).toBe('ask_human');
    });

    it('surfaces denials', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => ({ type: 'deny' as const, reason: 'risk too high' }),
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask delete prod db?');
      expect(stripAnsi(result!.message!)).toContain('Denied: risk too high');
    });

    it('explains when the brain escalates back to the human', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => ({ type: 'ask_human' as const, prompt: 'You decide.' }),
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask migrate the schema?');
      expect(stripAnsi(result!.message!)).toContain('escalated this question back to you');
    });

    it('requires a question', async () => {
      const ctx = makeCtx({ brain: { decide: vi.fn() } as never as BrainArbiter });
      const result = await buildBrainCommand(ctx).run!('ask');
      expect(result?.message).toMatch(/Usage/);
    });

    it('warns when the brain is not wired', async () => {
      const ctx = makeCtx();
      const result = await buildBrainCommand(ctx).run!('ask anything');
      expect(result?.message).toMatch(/not available/);
    });

    it('reports consultation failures instead of throwing', async () => {
      const ctx = makeCtx({
        brain: {
          decide: async () => {
            throw new Error('provider offline');
          },
        } as BrainArbiter,
      });
      const result = await buildBrainCommand(ctx).run!('ask anything');
      expect(result?.message).toContain('provider offline');
    });
  });

  it('rejects unknown subcommands', async () => {
    const ctx = makeCtx();
    const result = await buildBrainCommand(ctx).run!('frobnicate');
    expect(result?.message).toMatch(/Unknown subcommand/);
  });

  describe('runtime setters', () => {
    const makeFakeRuntime = (over: Partial<BrainConfigSnapshot> = {}) => {
      const patches: BrainConfigPatch[] = [];
      let persistOk = true;
      const snapshot: BrainConfigSnapshot = {
        mode: 'interactive',
        maxAutoRisk: 'medium',
        models: [],
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
          path: 'C:/x/brain-ledger.jsonl',
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
        llm: {
          maxTokens: 200,
          rejectUncertain: true,
          minConfidence: 0,
          denyIsTerminal: 'never',
        },
        trace: { enabled: false, content: 'full', path: undefined },
        monitor: {},
        terminalPolicy: 'conservative',
        decisionLogMaxEntries: 20,
        circuit: undefined,
        cache: { enabled: false, ttlMs: 300_000, maxEntries: 200, hits: 0, misses: 0, size: 0 },
        poolLabels: [],
        councilLabels: [],
        judgeLabel: undefined,
        judgeIsVoter: false,
        usingSessionModel: true,
        ...over,
      };
      const runtime = {
        arbiter: { decide: vi.fn() },
        getMode: () => snapshot.mode,
        getMaxAutoRisk: () => snapshot.maxAutoRisk,
        getHumanTimeoutMs: () => snapshot.humanTimeoutMs,
        getSnapshot: () => snapshot,
        getConfig: () => ({}),
        apply: vi.fn((patch: BrainConfigPatch) => {
          patches.push(patch);
          return {
            snapshot,
            persisted: Promise.resolve(
              persistOk ? { ok: true } : { ok: false, error: 'disk full' },
            ),
          };
        }),
      } as unknown as BrainRuntime;
      return {
        runtime,
        patches,
        setPersistOk: (v: boolean) => {
          persistOk = v;
        },
      };
    };

    it('/brain model <ref> replaces the pool with one entry and reports persistence', async () => {
      const { runtime, patches } = makeFakeRuntime({ poolLabels: ['prov/x'] });
      const ctx = makeCtx({ brainRuntime: runtime });
      const result = await buildBrainCommand(ctx).run!('model prov/x');
      expect(patches).toEqual([{ models: ['prov/x'] }]);
      const message = stripAnsi(result!.message!);
      expect(message).toContain('prov/x');
      expect(message).toContain('saved to the active profile config');
    });

    it('/brain council shows the DERIVED judge and flags one that is also a voter', async () => {
      // `council.judge` is undefined here — the common case. Status used to
      // print nothing at all, which is exactly when the derived judge can
      // silently be one of the seats that produced the tie it breaks.
      const { runtime } = makeFakeRuntime({
        council: {
          enabled: true,
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
        councilLabels: ['a/x (executor)', 'b/y (skeptic, veto)'],
        judgeLabel: 'a/x',
        // Resolved server-side. The surface must NOT infer this by matching
        // judgeLabel against the councilLabels display strings.
        judgeIsVoter: true,
      });
      const ctx = makeCtx({ brainRuntime: runtime });
      const message = stripAnsi((await buildBrainCommand(ctx).run!('council'))!.message!);
      expect(message).toContain('judge: a/x');
      expect(message).toContain('[derived]');
      expect(message).toContain('also a voter');
    });

    it('/brain council does not flag an independent derived judge', async () => {
      const { runtime } = makeFakeRuntime({
        council: {
          enabled: true,
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
        councilLabels: ['a/x (executor)', 'b/y (skeptic, veto)'],
        judgeLabel: 'c/z',
        judgeIsVoter: false,
      });
      const ctx = makeCtx({ brainRuntime: runtime });
      const message = stripAnsi((await buildBrainCommand(ctx).run!('council'))!.message!);
      expect(message).toContain('judge: c/z');
      expect(message).toContain('[derived]');
      expect(message).not.toContain('also a voter');
    });

    it('/brain model session clears the pool', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('model session');
      expect(patches).toEqual([{ models: null }]);
    });

    it('/brain models <refs> replaces the ordered pool', async () => {
      const { runtime, patches } = makeFakeRuntime({ poolLabels: ['a/x', 'b/y'] });
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('models a/x b/y');
      expect(patches).toEqual([{ models: ['a/x', 'b/y'] }]);
    });

    it('/brain models add appends to the current pool', async () => {
      const { runtime, patches } = makeFakeRuntime({
        models: [{ provider: 'a', model: 'x' }],
        poolLabels: ['a/x'],
      });
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('models add new/z');
      expect(patches).toEqual([{ models: ['a/x', 'new/z'] }]);
    });

    it('/brain models remove <index> drops the 1-based entry', async () => {
      const { runtime, patches } = makeFakeRuntime({
        models: [
          { provider: 'a', model: 'x' },
          { provider: 'b', model: 'y' },
        ],
        poolLabels: ['a/x', 'b/y'],
      });
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('models remove 1');
      expect(patches).toEqual([{ models: ['b/y'] }]);
    });

    it('/brain strategy round-robin patches the strategy', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('strategy round-robin');
      expect(patches).toEqual([{ strategy: 'round-robin' }]);
    });

    it('/brain timeout + human-timeout handle numeric and clearing forms', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({ brainRuntime: runtime });
      const cmd = buildBrainCommand(ctx);
      await cmd.run!('timeout 20000');
      await cmd.run!('timeout default');
      await cmd.run!('human-timeout 60000');
      await cmd.run!('human-timeout off');
      expect(patches).toEqual([
        { decisionTimeoutMs: 20000 },
        { decisionTimeoutMs: null },
        { humanTimeoutMs: 60000 },
        { humanTimeoutMs: null },
      ]);
    });

    it('/brain council subcommands build the right patches', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({ brainRuntime: runtime });
      const cmd = buildBrainCommand(ctx);
      await cmd.run!('council on');
      await cmd.run!('council minrisk medium');
      await cmd.run!('council voters a/x:skeptic:veto:w=2 b/y');
      await cmd.run!('council judge auto');
      await cmd.run!('council quorum 0.6');
      expect(patches).toEqual([
        { council: { enabled: true } },
        { council: { minRisk: 'medium' } },
        {
          council: {
            voters: [
              { provider: 'a', model: 'x', persona: 'skeptic', veto: true, weight: 2 },
              { provider: 'b', model: 'y' },
            ],
          },
        },
        { council: { judge: null } },
        { council: { quorum: 0.6 } },
      ]);
    });

    it('/brain council voters accepts every built-in persona as a bare token', async () => {
      // The shorthand set used to be a local ['executor','skeptic','auditor'],
      // so `a/x:security` parsed "security" as part of the model ref and the
      // seat silently kept the default lens.
      const { runtime, patches } = makeFakeRuntime();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));

      await cmd.run!('council voters a/x:security:veto b/y:maintainer c/z:user-advocate');

      expect(patches).toEqual([
        {
          council: {
            voters: [
              { provider: 'a', model: 'x', persona: 'security', veto: true },
              { provider: 'b', model: 'y', persona: 'maintainer' },
              { provider: 'c', model: 'z', persona: 'user-advocate' },
            ],
          },
        },
      ]);
    });

    it('/brain council exposes the knobs that used to be WebUI-only', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));

      await cmd.run!('council distinctness provider');
      await cmd.run!('council timeout 20000');
      await cmd.run!('council concurrency 6');
      await cmd.run!('council judgetokens 700');
      await cmd.run!('council judgetokens default');

      expect(patches).toEqual([
        { council: { distinctness: 'provider' } },
        { council: { perCallTimeoutMs: 20_000 } },
        { council: { maxConcurrency: 6 } },
        { council: { judgeMaxTokens: 700 } },
        { council: { judgeMaxTokens: null } },
      ]);
    });

    it('/brain council rejects an invalid distinctness without patching', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));

      const message = stripAnsi((await cmd.run!('council distinctness sometimes'))!.message!);

      expect(message).toContain('none|model|provider');
      expect(patches).toEqual([]);
    });

    it('/brain council personas lists every built-in lens without patching', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));

      const message = stripAnsi((await cmd.run!('council personas'))!.message!);

      for (const id of [
        'executor',
        'skeptic',
        'auditor',
        'security',
        'maintainer',
        'user-advocate',
      ]) {
        expect(message).toContain(id);
      }
      expect(patches).toEqual([]);
    });

    it('/brain ledger on|off and autodeny are setters; bare numeric stays a view', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({
        brainRuntime: runtime,
        brainSettings: { maxAutoRisk: 'medium', ledgerPath: 'Z:/definitely/missing/ledger.jsonl' },
      });
      const cmd = buildBrainCommand(ctx);
      await cmd.run!('ledger off');
      await cmd.run!('ledger autodeny 4');
      const view = await cmd.run!('ledger 15');
      expect(patches).toEqual([
        { ledger: { enabled: false } },
        { ledger: { autoDenyAfterFailures: 4 } },
      ]);
      expect(stripAnsi(view!.message!)).toContain('No ledger entries yet');
    });

    it('/brain save re-persists with an empty patch', async () => {
      const { runtime, patches } = makeFakeRuntime();
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('save');
      expect(patches).toEqual([{}]);
    });

    it('reports persist failures while keeping the live change', async () => {
      const { runtime, setPersistOk } = makeFakeRuntime();
      setPersistOk(false);
      const ctx = makeCtx({ brainRuntime: runtime });
      const result = await buildBrainCommand(ctx).run!('strategy fallback');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('NOT saved: disk full');
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
    });

    it('setters warn when the runtime is not wired', async () => {
      const ctx = makeCtx();
      const result = await buildBrainCommand(ctx).run!('model prov/x');
      expect(result?.message).toMatch(/not available/);
    });
  });

  describe('deterministic + quality subcommands', () => {
    const makeRt = (over: Partial<BrainConfigSnapshot> = {}) => {
      const patches: BrainConfigPatch[] = [];
      const snapshot: BrainConfigSnapshot = {
        mode: 'headless',
        maxAutoRisk: 'high',
        models: [],
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
          path: 'C:/x/l.jsonl',
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
        trace: { enabled: false, content: 'full', path: 'C:/x/brain-trace.jsonl' },
        monitor: {},
        terminalPolicy: 'conservative',
        decisionLogMaxEntries: 20,
        circuit: undefined,
        cache: { enabled: false, ttlMs: 300_000, maxEntries: 200, hits: 0, misses: 0, size: 0 },
        poolLabels: [],
        councilLabels: [],
        judgeLabel: undefined,
        judgeIsVoter: false,
        usingSessionModel: true,
        ...over,
      };
      const runtime: BrainRuntime = {
        arbiter: { decide: vi.fn() },
        getMode: () => snapshot.mode,
        getMaxAutoRisk: () => snapshot.maxAutoRisk,
        getHumanTimeoutMs: () => snapshot.humanTimeoutMs,
        getSnapshot: () => snapshot,
        getConfig: () => ({}),
        apply: (patch: BrainConfigPatch) => {
          patches.push(patch);
          return { snapshot, persisted: Promise.resolve({ ok: true }) };
        },
      };
      return { runtime, patches, snapshot };
    };

    it('/brain heuristics lists every built-in pattern', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime });
      const res = await buildBrainCommand(ctx).run!('heuristics');
      const msg = stripAnsi(res?.message ?? '');
      for (const name of ['lowrisk', 'blocked', 'deadlock', 'retry', 'continue']) {
        expect(msg).toContain(name);
      }
    });

    it('/brain heuristics <name> off maps onto the right config field', async () => {
      const { runtime, patches } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime });
      await buildBrainCommand(ctx).run!('heuristics deadlock off');
      expect(patches).toEqual([{ heuristics: { deadlockSkip: false } }]);
    });

    it('/brain heuristics rejects an unknown name', async () => {
      const { runtime, patches } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime });
      const res = await buildBrainCommand(ctx).run!('heuristics bogus on');
      expect(patches).toEqual([]);
      expect(stripAnsi(res?.message ?? '')).toContain('Usage:');
    });

    it('/brain llm shows the quality gate', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime });
      const msg = stripAnsi((await buildBrainCommand(ctx).run!('llm'))?.message ?? '');
      expect(msg).toContain('maxTokens');
      expect(msg).toContain('denyIsTerminal');
    });

    it('/brain llm setters build the expected patches', async () => {
      const { runtime, patches } = makeRt();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));
      await cmd.run!('llm maxtokens 512');
      await cmd.run!('llm uncertain off');
      await cmd.run!('llm confidence 0.7');
      await cmd.run!('llm deny when-decided');
      await cmd.run!('llm breaker 5 30000');
      expect(patches).toEqual([
        { llm: { maxTokens: 512 } },
        { llm: { rejectUncertain: false } },
        { llm: { minConfidence: 0.7 } },
        { llm: { denyIsTerminal: 'when-decided' } },
        { llm: { circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 } } },
      ]);
    });

    it('/brain llm breaker off disables the breaker', async () => {
      const { runtime, patches } = makeRt();
      await buildBrainCommand(makeCtx({ brainRuntime: runtime })).run!('llm breaker off');
      expect(patches).toEqual([{ llm: { circuitBreaker: { failureThreshold: 0 } } }]);
    });

    it('/brain trace on warns that content lands on disk', async () => {
      const { runtime, patches } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime });
      const res = await buildBrainCommand(ctx).run!('trace on');
      expect(patches).toEqual([{ trace: { enabled: true } }]);
      expect(stripAnsi(res?.message ?? '')).toContain('disk');
    });

    it('/brain trace content validates the mode', async () => {
      const { runtime, patches } = makeRt();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));
      await cmd.run!('trace content redacted');
      const bad = await cmd.run!('trace content loud');
      expect(patches).toEqual([{ trace: { content: 'redacted' } }]);
      expect(stripAnsi(bad?.message ?? '')).toContain('Usage:');
    });

    it('/brain cache reports the hit rate', async () => {
      const { runtime } = makeRt({
        cache: { enabled: true, ttlMs: 1000, maxEntries: 10, hits: 3, misses: 1, size: 2 },
      });
      const msg = stripAnsi(
        (await buildBrainCommand(makeCtx({ brainRuntime: runtime })).run!('cache'))?.message ?? '',
      );
      expect(msg).toContain('75% hit rate');
    });

    it('/brain escalation validates the policy', async () => {
      const { runtime, patches } = makeRt();
      const cmd = buildBrainCommand(makeCtx({ brainRuntime: runtime }));
      await cmd.run!('escalation deny-all');
      await cmd.run!('escalation nonsense');
      expect(patches).toEqual([{ terminalPolicy: 'deny-all' }]);
    });

    it('/brain monitor policy reports a live change, not a deferred one', async () => {
      // Monitor settings used to be the ONE knob that persisted but did not
      // apply until restart; the host now forwards them to
      // BrainMonitor.reconfigure() from the runtime's onApplied.
      const { runtime, patches } = makeRt();
      const res = await buildBrainCommand(makeCtx({ brainRuntime: runtime })).run!(
        'monitor policy observe',
      );
      expect(patches).toEqual([{ monitor: { policy: 'observe' } }]);
      const message = stripAnsi(res?.message ?? '');
      expect(message).toContain('applied live');
      expect(message).not.toContain('next session');
    });

    it('/brain rules surfaces compile errors alongside the table', async () => {
      const { runtime } = makeRt({
        rules: [{ id: 'ok', when: {}, then: { action: 'deny' } }],
        ruleErrors: ['broken: invalid question pattern'],
      });
      const msg = stripAnsi(
        (await buildBrainCommand(makeCtx({ brainRuntime: runtime })).run!('rules'))?.message ?? '',
      );
      expect(msg).toContain('ok');
      expect(msg).toContain('broken');
    });

    it('/brain rules clear empties the table', async () => {
      const { runtime, patches } = makeRt();
      await buildBrainCommand(makeCtx({ brainRuntime: runtime })).run!('rules clear');
      expect(patches).toEqual([{ rules: null }]);
    });

    it('/brain stats splits deterministic from model-backed decisions', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({
        brainRuntime: runtime,
        getBrainLog: () => {
          const log = [
            { at: 1, kind: 'answered', question: 'a', outcome: 'allow', tier: 'rule' },
            { at: 2, kind: 'answered', question: 'b', outcome: 'allow', tier: 'heuristic' },
            { at: 3, kind: 'answered', question: 'c', outcome: 'allow', tier: 'llm' },
          ];
          return log;
        },
      });
      const msg = stripAnsi((await buildBrainCommand(ctx).run!('stats'))?.message ?? '');
      expect(msg).toContain('deterministic');
      expect(msg).toContain('model-backed');
      // 2 of 3 decided without a provider call.
      expect(msg).toContain('67% of decided');
    });

    it('/brain stats prefers the session-lifetime counter over the ring buffer', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({
        brainRuntime: runtime,
        // The ring only ever holds the last 20 — it must not be what the
        // percentages are computed from once a real counter is wired.
        getBrainLog: () => [{ at: 1, kind: 'answered', question: 'a', outcome: 'x', tier: 'llm' }],
        brainTierStats: () => ({
          byTier: { rule: 90, llm: 10 },
          total: 100,
          deterministic: 90,
          llmBacked: 10,
          unattributed: 0,
        }),
      });
      const msg = stripAnsi((await buildBrainCommand(ctx).run!('stats'))?.message ?? '');
      expect(msg).toContain('90% of decided');
      expect(msg).toContain('100 decision(s) this session');
    });

    it('/brain stats surfaces decisions the chain never attributed', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({
        brainRuntime: runtime,
        getBrainLog: () => [],
        brainTierStats: () => ({
          byTier: { policy: 2 },
          total: 5,
          deterministic: 2,
          llmBacked: 0,
          unattributed: 3,
        }),
      });
      const msg = stripAnsi((await buildBrainCommand(ctx).run!('stats'))?.message ?? '');
      expect(msg).toContain('unattributed');
    });

    it('/brain stats copes with an empty log', async () => {
      const { runtime } = makeRt();
      const ctx = makeCtx({ brainRuntime: runtime, getBrainLog: () => [] });
      const msg = stripAnsi((await buildBrainCommand(ctx).run!('stats'))?.message ?? '');
      expect(msg).toContain('No decisions recorded');
    });

    it('lists the new subcommands in argsHint, help and the unknown-subcommand hint', async () => {
      const cmd = buildBrainCommand(makeCtx());
      for (const name of [
        'stats',
        'rules',
        'heuristics',
        'llm',
        'trace',
        'cache',
        'escalation',
        'monitor',
      ]) {
        expect(cmd.argsHint).toContain(name);
        expect(cmd.help).toContain(name);
      }
      const res = await cmd.run!('definitely-not-a-subcommand');
      expect(stripAnsi(res?.message ?? '')).toContain('stats');
    });
  });
});
