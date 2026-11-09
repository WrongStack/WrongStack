import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Provider } from '@wrongstack/contracts/types/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutonomousBrain } from '../../../coordination/src/autonomous-brain.js';
import type { KnowledgeGraph } from '../../../coordination/src/knowledge-graph.js';
import {
  BrainDecisionQueue,
  type BrainDecisionRequest,
  DefaultBrainArbiter,
  EscalationRoutingBrainArbiter,
  ObservableBrainArbiter,
} from '../../src/brain/brain.js';
import { BrainDecisionCache, brainCacheKey } from '../../src/brain/brain-cache.js';
import {
  BrainDecisionLedger,
  createLedgerGuardBrainArbiter,
} from '../../src/brain/brain-ledger.js';
import { BrainMonitor } from '../../src/brain/brain-monitor.js';
import { compileBrainRules } from '../../src/brain/brain-rules.js';
import { BrainTierCounter, readDecisionTier } from '../../src/brain/brain-telemetry.js';
import {
  BrainTraceRecorder,
  readBrainTrace,
  sanitizeDecision,
} from '../../src/brain/brain-trace.js';
import { createEventUserInputAwaiter } from '../../src/core/user-input-awaiter.js';
import {
  createAutonomyBrain,
  createTieredBrainArbiter,
  readLlmDenyKind,
} from '../../src/execution/autonomy-brain.js';
import { BrainCircuitBreaker } from '../../src/execution/brain-circuit.js';
import {
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from '../../src/execution/brain-runtime.js';
import { createSystemOneBrainTier } from '../../src/execution/brain-system-one.js';

// Permanent regressions for the October Brain architecture review.
const request = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'audit-request',
  source: 'system',
  question: 'Evaluate the proposed action.',
  context: 'Concrete evidence supplied.',
  risk: 'medium',
  fallback: 'ask_human',
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  ...over,
});
const provider = (text = '{"optionId":"approve"}'): Provider =>
  ({
    id: 'session',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  }) as never;
const runtimes: ReturnType<typeof createBrainRuntime>[] = [];
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.dispose();
  vi.useRealTimers();
});
function runtime(
  cfg: Parameters<typeof createBrainRuntime>[0]['initialConfig'],
  p = provider(),
  extra: Partial<Parameters<typeof createBrainRuntime>[0]> = {},
) {
  const rt = createBrainRuntime({
    initialConfig: cfg,
    defaultProviderId: 'session',
    sessionProvider: () => p,
    sessionModel: () => 'session-model',
    resolveProvider: () => null,
    ...extra,
  });
  runtimes.push(rt);
  return rt;
}

describe('Brain architecture regressions', () => {
  it.each(['success', 'completed'] as const)(
    'does not apply a pending tool steer after %s',
    async (resolution) => {
      const events = new EventBus();
      let finish!: (value: { type: 'answer'; optionId: string; text: string }) => void;
      const pending = new Promise<{ type: 'answer'; optionId: string; text: string }>((resolve) => {
        finish = resolve;
      });
      const intervene = vi.fn(async () => {});
      const monitor = new BrainMonitor({
        events,
        brain: { decide: () => pending },
        intervene,
        toolFailureStreak: 1,
        stallMs: 0,
      });
      monitor.start();
      events.emit('tool.executed', { id: 'failure', name: 'edit', ok: false, durationMs: 1 });
      if (resolution === 'success')
        events.emit('tool.executed', { id: 'recovered', name: 'edit', ok: true, durationMs: 1 });
      else
        events.emit('agent.run.completed', {
          ctx: {} as never,
          status: 'done',
          iterations: 1,
          at: new Date().toISOString(),
          durationMs: 1,
        });
      finish({ type: 'answer', optionId: 'steer', text: 'Change approach' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(intervene).not.toHaveBeenCalled();
      monitor.stop();
    },
  );

  it('does not steer on an expired error-storm window after a delayed decision', async () => {
    vi.useFakeTimers();
    const events = new EventBus();
    let finish!: (value: { type: 'answer'; optionId: string; text: string }) => void;
    const pending = new Promise<{ type: 'answer'; optionId: string; text: string }>((resolve) => {
      finish = resolve;
    });
    const intervene = vi.fn(async () => {});
    const monitor = new BrainMonitor({
      events,
      brain: { decide: () => pending },
      intervene,
      errorStormCount: 1,
      errorStormWindowMs: 10,
      stallMs: 0,
    });
    monitor.start();
    events.emit('error', { err: new Error('boom'), phase: 'test' });
    vi.advanceTimersByTime(11);
    finish({ type: 'answer', optionId: 'steer', text: 'Change approach' });
    await vi.runAllTimersAsync();
    expect(intervene).not.toHaveBeenCalled();
    monitor.stop();
  });
  it('clears product human timeout to 120 seconds while preserving raw API defaults and explicit indefinite waiting', () => {
    const rt = runtime(resolveBrainConfigDefaults({ mode: 'interactive', humanTimeoutMs: 5 }));
    rt.apply({ humanTimeoutMs: null }, { persist: false });
    expect(rt.getHumanTimeoutMs()).toBe(120_000);
    expect(rt.getConfig().humanTimeoutMs).toBeUndefined();
    rt.apply({ humanTimeoutMs: 0 }, { persist: false });
    expect(rt.getHumanTimeoutMs()).toBe(0);
    const raw = runtime({});
    raw.apply({ humanTimeoutMs: null }, { persist: false });
    expect(raw.getHumanTimeoutMs()).toBeUndefined();
  });
  it('resets ledger enablement live and rejects malformed enablement before any mutation', () => {
    let enabled = false;
    const ledger = {
      getPath: () => undefined,
      isEnabled: () => enabled,
      setEnabled: (value: boolean) => {
        enabled = value;
      },
    };
    const rt = runtime({ ledger: { enabled: false } }, provider(), { ledger });
    expect(() => rt.apply({ ledger: { enabled: 'false' as never } }, { persist: false })).toThrow(
      'ledger.enabled',
    );
    expect(enabled).toBe(false);
    rt.apply({ ledger: null }, { persist: false });
    expect(rt.getSnapshot().ledger.enabled).toBe(true);
    expect(rt.getConfig().ledger).toBeUndefined();
  });
  it('defers Jev safely when resolving the account itself throws', async () => {
    const tier = createSystemOneBrainTier({
      getJudge: () => {
        throw new Error('account unavailable');
      },
    });
    expect(await tier.decide(request())).toBeNull();
    const rt = runtime({}, provider(), {
      getSystemOneJudge: () => {
        throw new Error('account unavailable');
      },
    });
    expect(rt.explain(request()).verdict.nextTierIfNotSettled).toBe('autonomous_llm');
    expect((await rt.arbiter.decide(request())).type).toBe('answer');
  });

  it('records coordinator decisions under their request identity and forwards real outcome hints through the shared arbiter', async () => {
    const nodes = new Map<string, Record<string, unknown>>();
    const graph = {
      getDecisions: () => [...nodes.values()],
      get: (id: string) => nodes.get(id),
      add: async (data: Record<string, unknown>) => {
        const id = String(data.id ?? crypto.randomUUID());
        const node = { ...data, id };
        nodes.set(id, node);
        return node;
      },
      update: async () => undefined,
    } as never as KnowledgeGraph;
    const arbiter = {
      decide: vi.fn(async () => ({
        type: 'answer' as const,
        optionId: 'approve',
        text: 'Approve',
      })),
    };
    const llmProvider = { decide: vi.fn() };
    const brain = new AutonomousBrain({ graph, arbiter, sessionId: 'A', llmProvider });
    await brain.decide(request());
    expect(nodes.has('audit-request')).toBe(true);
    brain.recordOutcome('audit-request', 'failure');
    brain.recordOutcome('audit-request', 'failure');
    await brain.decide(request({ id: 'next-request' }));
    expect(arbiter.decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'A',
        context: expect.stringContaining('decisions have failed 2 times'),
      }),
    );
    expect(llmProvider.decide).not.toHaveBeenCalled();
    arbiter.decide.mockRejectedValueOnce(new Error('shared brain unavailable'));
    expect(
      (
        await brain.decide(
          request({
            risk: 'low',
            options: [{ id: 'approve', label: 'Approve', recommended: true }],
          }),
        )
      ).type,
    ).toBe('deny');
  });
  it('keeps an inferred risk ceiling adaptive through pool edits and persistence', async () => {
    const rt = runtime(resolveBrainConfigDefaults({ models: ['session/a', 'session/b'] }));
    expect(rt.getMaxAutoRisk()).toBe('all');
    expect(rt.getConfig().maxAutoRisk).toBeUndefined();
    rt.apply({ council: { enabled: false } }, { persist: false });
    expect(rt.getMaxAutoRisk()).toBe('high');
    rt.apply({ maxAutoRisk: 'low', council: { enabled: true } }, { persist: false });
    expect(rt.getMaxAutoRisk()).toBe('low');
    expect(rt.getConfig().maxAutoRisk).toBe('low');
  });

  it('honors a concrete LLM refusal without consulting another model', async () => {
    const first = provider(
      '{"type":"deny","reason":"Concrete evidence shows data loss.","confidence":0.9}',
    );
    const second = provider();
    const rt = runtime({ maxAutoRisk: 'high' }, first);
    expect(await rt.arbiter.decide(request())).toMatchObject({
      type: 'deny',
      reason: 'Concrete evidence shows data loss.',
    });
    const verdict = await createAutonomyBrain({
      targets: [
        { provider: first, model: 'a' },
        { provider: second, model: 'b' },
      ],
    }).decide(request());
    expect(readLlmDenyKind(verdict)).toBe('refused');
    expect(second.complete).not.toHaveBeenCalled();
  });

  it('explain sees the live rule quota without consuming it', async () => {
    const rt = runtime({
      maxAutoRisk: 'off',
      rules: [
        {
          id: 'one',
          maxHits: 1,
          when: { offersOption: 'approve' },
          // biome-ignore lint/suspicious/noThenProperty: domain rule field.
          then: { action: 'answer', optionId: 'approve' },
        },
      ],
    });
    expect(rt.explain(request()).verdict.resolvingTier).toBe('rule');
    expect(rt.explain(request()).verdict.resolvingTier).toBe('rule');
    expect((await rt.arbiter.decide(request())).type).toBe('answer');
    expect(rt.explain(request()).verdict.nextTierIfNotSettled).toBe('ask_human');
    expect((await rt.arbiter.decide(request())).type).toBe('ask_human');
  });

  it('structured human escalation uses the existing session-scoped form and closes it on timeout', async () => {
    const events = new EventBus();
    const forms: unknown[] = [];
    events.on('user.input_requested', (event) => forms.push(event));
    const opts = { timeoutMs: 1000, userInputAwaiter: createEventUserInputAwaiter(events) };
    const queue = new BrainDecisionQueue(events, opts);
    const answered = queue.requestHumanDecision(request({ sessionId: 'A' }));
    expect(forms).toHaveLength(1);
    const response = {
      requestId: 'audit-request',
      status: 'submitted' as const,
      answers: [
        { questionId: 'decision', selectedOptionIds: ['reject'], usedRecommendation: false },
      ],
    };
    events.emit('user.input_submitted', { sessionId: 'B', response });
    events.emit('user.input_submitted', { sessionId: 'A', response });
    expect(await answered).toMatchObject({ type: 'answer', optionId: 'reject' });
    opts.timeoutMs = 5;
    const resolved: unknown[] = [];
    events.on('user.input_resolved', (event) => resolved.push(event));
    expect(
      (await queue.requestHumanDecision(request({ id: 'timeout', sessionId: 'A' }))).type,
    ).toBe('deny');
    expect(resolved).toHaveLength(1);
    queue.dispose();
  });

  it('terminal provenance is preserved when another human escalation is forbidden', async () => {
    const events = new EventBus();
    const rt = runtime({ maxAutoRisk: 'off' }, provider(), { events });
    const brain = new ObservableBrainArbiter(
      new EscalationRoutingBrainArbiter(
        rt.arbiter,
        undefined,
        () => 'headless',
        () => 'deny-all',
        events,
      ),
      events,
    );
    const req = request({ allowHumanEscalation: false });
    expect((await brain.decide(req)).type).toBe('deny');
    expect(readDecisionTier(req)).toBe('terminal');
    expect(rt.getTierStats().byTier).toEqual({ terminal: 1 });
  });

  it('trace reconfiguration keeps queued rows at their original destination and changes capture policy', async () => {
    const events = new EventBus();
    const first = `.temp_files/brain-fix-trace-first-${crypto.randomUUID()}.jsonl`;
    const second = `.temp_files/brain-fix-trace-second-${crypto.randomUUID()}.jsonl`;
    const trace = new BrainTraceRecorder({ events, filePath: first });
    trace.start();
    const rt = runtime({}, provider(), { events });
    const brain = new ObservableBrainArbiter(rt.arbiter, events);
    await brain.decide(
      request({
        id: 'first',
        risk: 'low',
        options: [{ id: 'approve', label: 'Approve', recommended: true }],
      }),
    );
    trace.reconfigure({ filePath: second, content: 'none' });
    await brain.decide(
      request({
        id: 'second',
        risk: 'low',
        options: [{ id: 'approve', label: 'Approve', recommended: true }],
      }),
    );
    await trace.stop();
    expect((await readBrainTrace(first)).map((row) => row.requestId)).toEqual(['first']);
    const rows = await readBrainTrace(second);
    expect(rows.map((row) => row.requestId)).toEqual(['second']);
    expect(JSON.stringify(rows)).not.toContain('Concrete evidence supplied.');
  });

  it('runtime disposal drops watchers and prevents a late approval', async () => {
    const events = new EventBus();
    let finish!: (value: unknown) => void;
    const p = provider();
    vi.mocked(p.complete).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const rt = runtime({ cache: { enabled: true } }, p, { events });
    const pending = rt.arbiter.decide(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    rt.dispose();
    finish({ content: [{ type: 'text', text: '{"optionId":"approve"}' }] });
    expect((await pending).type).toBe('deny');
    expect(events.listenerCount('brain.tier_transition')).toBe(0);
    expect((await rt.arbiter.decide(request())).type).toBe('deny');
  });
  it('lowers the inferred ceiling when no council can actually convene', async () => {
    const p = provider();
    const rt = runtime(resolveBrainConfigDefaults({ models: ['missing/a', 'missing/b'] }), p);
    expect(rt.getSnapshot()).toMatchObject({
      maxAutoRisk: 'high',
      council: { enabled: false },
      usingSessionModel: true,
    });
    const result = await rt.arbiter.decide(request({ risk: 'critical' }));
    expect(result.type).toBe('ask_human');
    expect(p.complete).not.toHaveBeenCalled();
  });

  it('escalates a critical council abstention without trying a single model', async () => {
    const single = {
      decide: vi.fn(async () => ({
        type: 'answer' as const,
        optionId: 'approve',
        text: 'Approve',
      })),
    };
    const council = {
      decide: vi.fn(async () => ({ type: 'ask_human' as const, prompt: 'Quorum missing' })),
    };
    const brain = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: single,
      council,
      getMaxAutoRisk: () => 'all',
    });
    expect((await brain.decide(request({ risk: 'critical' }))).type).toBe('ask_human');
    expect(single.decide).not.toHaveBeenCalled();
  });

  it('explain honors risk off before council eligibility', async () => {
    const rt = runtime({ models: ['session/a', 'session/b'], maxAutoRisk: 'off' });
    const req = request({ risk: 'high' });
    expect(rt.explain(req).verdict.nextTierIfNotSettled).toBe('ask_human');
    expect((await rt.arbiter.decide(req)).type).toBe('ask_human');
  });

  it('explain preserves a terminal deny policy before autonomous heuristics', async () => {
    const rt = runtime({ maxAutoRisk: 'all' });
    const req = request({
      question: 'Deadlock detected. What now?',
      context: 'Failed tasks block remaining work.',
      options: undefined,
      fallback: 'deny',
    });
    expect(rt.explain(req).verdict.decision?.type).toBe('deny');
    expect((await rt.arbiter.decide(req)).type).toBe('deny');
  });

  it('explain treats zero as disabling the ledger guard', async () => {
    const rt = runtime({ ledger: { autoDenyAfterFailures: 0 } }, provider(), {
      ledger: {
        isEnabled: () => true,
        failureStreakFor: () => 0,
        getPath: () => undefined,
        setEnabled: () => {},
      },
    });
    expect(rt.explain(request()).verdict.resolvingTier).not.toBe('ledger_guard');
    expect((await rt.arbiter.decide(request())).type).toBe('answer');
  });

  it('a negated resolution word cannot assert that a blocker is resolved', async () => {
    const result = await new DefaultBrainArbiter().decide(
      request({
        question: 'The dependency is blocked.',
        context: 'The dependency is not fixed and is still failing.',
        fallback: 'continue',
        options: undefined,
      }),
    );
    expect(result).toMatchObject({ type: 'answer', text: 'Continue with the caller default.' });
  });

  it('tries another model after an unusable response and retains invalid-response failure health', async () => {
    const first = provider('garbage');
    const second = provider();
    const plainBrain = createAutonomyBrain({
      targets: [
        { provider: first, model: 'a' },
        { provider: second, model: 'b' },
      ],
      circuit: new BrainCircuitBreaker(),
    });
    expect(await plainBrain.decide(request())).toMatchObject({
      type: 'answer',
      optionId: 'approve',
    });
    expect(second.complete).toHaveBeenCalledOnce();
    // Unusable responses must not reset health as successful decisions.
    const onlyBad = new BrainCircuitBreaker();
    onlyBad.recordFailure();
    await createAutonomyBrain({ provider: first, model: 'a', circuit: onlyBad }).decide(request());
    expect(onlyBad.snapshot().consecutiveFailures).toBe(2);
  });

  it('cache keeps different decision-relevant expiration dates separate', () => {
    const req = request({ question: 'May this certificate be accepted?' });
    expect(
      brainCacheKey({ ...req, context: 'Certificate expires: 2026-10-01T00:00:00Z' }),
    ).not.toBe(brainCacheKey({ ...req, context: 'Certificate expires: 2027-10-01T00:00:00Z' }));
  });

  it('coordinator rejects a model option that was not offered', async () => {
    const graph = {
      getDecisions: () => [],
      add: vi.fn(async (data: Record<string, unknown>) => ({ id: 'graph-generated-id', ...data })),
    } as never as KnowledgeGraph;
    const brain = new AutonomousBrain({
      graph,
      llmProvider: {
        decide: async () => ({ optionId: 'invented', rationale: 'Unvalidated result' }),
      },
    });
    expect((await brain.decide(request())).type).toBe('deny');
    expect(graph.add).not.toHaveBeenCalled();
  });

  it('a same-kind intervention in session B cannot fail session A', async () => {
    const events = new EventBus();
    const ledger = new BrainDecisionLedger({
      events,
      filePath: `.temp_files/brain-review-ledger-${crypto.randomUUID()}.jsonl`,
    });
    await ledger.start();
    const at = Date.now();
    const decision = { type: 'answer' as const, optionId: 'steer', text: 'Read evidence' };
    events.emit('brain.intervention', {
      sessionId: 'A',
      kind: 'tool_failure_streak',
      request: request({ id: 'A-request', sessionId: 'A' }),
      decision,
      intervened: true,
      at,
    });
    events.emit('brain.intervention', {
      sessionId: 'B',
      kind: 'tool_failure_streak',
      request: request({ id: 'B-request', sessionId: 'B' }),
      decision,
      intervened: true,
      at: at + 1,
    });
    expect(ledger.tail(5).filter((entry) => entry.kind === 'outcome')).toHaveLength(0);
    await ledger.stop();
  });

  it('ledger tuning updates the retry window and memory cap without restarting correlation', async () => {
    const events = new EventBus();
    const ledger = new BrainDecisionLedger({
      events,
      filePath: `.temp_files/brain-fix-ledger-${crypto.randomUUID()}.jsonl`,
    });
    await ledger.start();
    const decision = { type: 'answer' as const, optionId: 'steer', text: 'Read evidence' };
    const at = Date.now();
    events.emit('brain.intervention', {
      sessionId: 'A',
      kind: 'tool_failure_streak',
      request: request({ id: 'first' }),
      decision,
      intervened: true,
      at,
    });
    events.emit('brain.intervention', {
      sessionId: 'B',
      kind: 'tool_failure_streak',
      request: request({ id: 'other-session' }),
      decision,
      intervened: true,
      at,
    });
    ledger.reconfigure({ maxMemoryEntries: 1, interventionRetryWindowMs: 1 });
    expect(ledger.tail(5)).toHaveLength(1);
    events.emit('brain.intervention', {
      sessionId: 'A',
      kind: 'tool_failure_streak',
      request: request({ id: 'after-window' }),
      decision,
      intervened: true,
      at: at + 2,
    });
    expect(ledger.tail(5)).toEqual([
      expect.objectContaining({ requestId: 'after-window', kind: 'intervention' }),
    ]);
    await ledger.stop();
  });

  it('runtime stats retain heuristic provenance and include Jev model decisions', async () => {
    const events = new EventBus();
    const rt = runtime({}, provider(), { events });
    const req = request({
      risk: 'low',
      options: [{ id: 'approve', label: 'Approve', recommended: true }],
    });
    await rt.arbiter.decide(req);
    expect(readDecisionTier(req)).toBe('heuristic');
    expect(rt.getTierStats().byTier).toEqual({ heuristic: 1 });
    const counter = new BrainTierCounter();
    counter.record('system-one');
    expect(counter.snapshot()).toMatchObject({ total: 1, deterministic: 0, llmBacked: 1 });
  });

  it.each(['stop', 'disable', 'retune'] as const)(
    'monitor %s invalidates a pending non-stall steer',
    async (action) => {
      const events = new EventBus();
      let finish!: (value: {
        type: 'answer';
        optionId: string;
        text: string;
        rationale: string;
      }) => void;
      const pending = new Promise<{
        type: 'answer';
        optionId: string;
        text: string;
        rationale: string;
      }>((resolve) => {
        finish = resolve;
      });
      const intervene = vi.fn(async () => {});
      const monitor = new BrainMonitor({
        events,
        brain: { decide: () => pending },
        intervene,
        toolFailureStreak: 1,
        stallMs: 0,
      });
      monitor.start();
      events.emit('tool.executed', {
        id: 'failed',
        name: 'edit',
        ok: false,
        durationMs: 1,
        output: 'boom',
      });
      if (action === 'stop') monitor.stop();
      else
        monitor.reconfigure(
          action === 'disable' ? { enabled: false } : { toolFailureStreak: 2, stallMs: 0 },
        );
      finish({
        type: 'answer',
        optionId: 'steer',
        text: 'Change approach',
        rationale: 'Read before editing',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(intervene).not.toHaveBeenCalled();
      monitor.stop();
    },
  );
  expect(brainCacheKey(request({ question: 'Accept value "a  b"?' }))).not.toBe(
    brainCacheKey(request({ question: 'Accept value "a b"?' })),
  );

  it('marks prior steer as failure on suppressed re-trigger, blocks untagged human answers on session-scoped escalations, and marks terminal tier', async () => {
    const events = new EventBus();
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'brain-retrigger-ledger-'));
    const ledger = new BrainDecisionLedger({
      events,
      filePath: join(dir, 'ledger.jsonl'),
      interventionRetryWindowMs: 60_000,
    });
    await ledger.start();

    events.emit('brain.intervention', {
      at: 1000,
      sessionId: 'sess-retrigger',
      kind: 'tool_failure_streak',
      intervened: true,
      request: request({ id: 'steer-1', sessionId: 'sess-retrigger' }),
      decision: {
        type: 'steer',
        guidance: 'retry differently',
        reason: 'streak',
        decidedBy: 'rule',
        confidence: 0.8,
      },
    } as never);
    events.emit('brain.intervention', {
      at: 2000,
      sessionId: 'sess-retrigger',
      kind: 'tool_failure_streak',
      intervened: false,
      request: request({ id: 'steer-2', sessionId: 'sess-retrigger' }),
      decision: {
        type: 'continue',
        reason: 'suppressed',
        decidedBy: 'policy',
        confidence: 0.5,
      },
    } as never);
    const outcomeEntry = ledger
      .tail(10)
      .find((e) => e.kind === 'outcome' && e.requestId === 'steer-1');
    expect(outcomeEntry?.outcome).toBe('failure');
    await ledger.stop();
    await rm(dir, { recursive: true, force: true });

    const queue = new BrainDecisionQueue(events, { timeoutMs: 50 });
    const scopedPromise = queue.requestHumanDecision(
      request({ id: 'scoped-1', sessionId: 'sess-A', options: undefined }),
    );
    events.emit('brain.human_answered', {
      id: 'scoped-1',
      sessionId: undefined,
      deny: false,
      text: 'untagged answer',
      at: Date.now(),
    });
    const scopedRes = await scopedPromise;
    expect(scopedRes.type).toBe('deny');

    const { HumanEscalatingBrainArbiter } = await import('../../src/brain/brain.js');
    const { readDecisionTier } = await import('../../src/brain/brain-telemetry.js');
    const escArbiter = new HumanEscalatingBrainArbiter(new DefaultBrainArbiter(), queue);
    const termReq = request({
      id: 'term-req',
      risk: 'critical',
      fallback: 'ask_human',
      allowHumanEscalation: false,
    });
    await escArbiter.decide(termReq);
    expect(readDecisionTier(termReq)).toBe('terminal');
    queue.dispose();
  });

  it('fences BrainDecisionLedger start/stop/load against duplicate listeners and post-stop seed mutation', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'brain-ledger-race-'));
    try {
      const seedPath = join(dir, 'seed.jsonl');
      await writeFile(
        seedPath,
        `${JSON.stringify({
          at: 500,
          sessionId: 's-seed',
          requestId: 'seed-1',
          kind: 'answered',
          source: 'director',
          risk: 'medium',
          question: 'Seeded question?',
          optionId: 'approve',
        })}\n`,
        'utf8',
      );
      const events = new EventBus();
      const ledger = new BrainDecisionLedger({ events, filePath: seedPath });

      const firstStart = ledger.start();
      await ledger.stop();
      await firstStart;
      expect(ledger.tail(10)).toHaveLength(0);

      await ledger.start();
      await ledger.start();
      events.emit('brain.decision_answered', {
        sessionId: 's-live',
        request: request({ id: 'live-1' }),
        decision: { type: 'answer', optionId: 'approve', text: 'Approve' },
        at: 2000,
      });
      await ledger.stop();

      const rows = ledger.tail(10);
      expect(rows.filter((r) => r.requestId === 'seed-1')).toHaveLength(1);
      expect(rows.filter((r) => r.requestId === 'live-1')).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks terminal tier and emits terminal transitions when BrainDecisionQueue denies on dispose or duplicate id', async () => {
    const events = new EventBus();
    const counter = new BrainTierCounter();
    const deniedTiers: Array<string | undefined> = [];
    events.on('brain.tier_transition', (e) => {
      if (e.terminal) counter.record(e.tier);
    });
    events.on('brain.decision_denied', (e) => {
      deniedTiers.push(e.tier);
    });

    const queue = new BrainDecisionQueue(events);
    const arbiter = new ObservableBrainArbiter(
      new EscalationRoutingBrainArbiter(
        createTieredBrainArbiter({
          policy: new DefaultBrainArbiter(),
          events,
        }),
        queue,
        () => 'interactive',
        undefined,
        events,
      ),
      events,
    );

    const reqInFlight = request({ id: 'q-in-flight', risk: 'high' });
    const inFlight = arbiter.decide(reqInFlight);
    await Promise.resolve();
    await Promise.resolve();

    const reqDuplicate = request({ id: 'q-in-flight', risk: 'high' });
    const dupDecision = await arbiter.decide(reqDuplicate);

    queue.dispose();
    const disposedDecision = await inFlight;

    const reqAfterDispose = request({ id: 'q-after-dispose', risk: 'high' });
    const afterDisposeDecision = await arbiter.decide(reqAfterDispose);

    expect([dupDecision.type, disposedDecision.type, afterDisposeDecision.type]).toEqual([
      'deny',
      'deny',
      'deny',
    ]);
    expect([
      readDecisionTier(reqDuplicate),
      readDecisionTier(reqInFlight),
      readDecisionTier(reqAfterDispose),
    ]).toEqual(['terminal', 'terminal', 'terminal']);
    expect(deniedTiers).toEqual(['terminal', 'terminal', 'terminal']);
    expect(counter.snapshot().byTier.terminal).toBe(3);
  });

  it('guards ledger tail(), preserves intervention kind on completion, sanitizes ask_human options, and validates rule bounds (F105)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'brain-f105-'));
    try {
      const events = new EventBus();
      const ledger = new BrainDecisionLedger({
        events,
        filePath: join(dir, 'ledger.jsonl'),
      });
      await ledger.start();
      ledger.recordOutcome('req-1', 'success', 'ok', 'sess-1');
      expect(ledger.tail(0)).toEqual([]);
      expect(ledger.tail(-1)).toEqual([]);
      expect(ledger.tail(Number.NaN)).toEqual([]);
      expect(ledger.tail(1.8)).toHaveLength(1);

      events.emit('brain.intervention', {
        at: 1000,
        sessionId: 'sess-1',
        kind: 'agent_stall',
        intervened: true,
        request: request({ id: 'req-int-1', sessionId: 'sess-1', source: 'system' }),
        decision: { type: 'answer', text: 'steer' },
      });
      events.emit('agent.run.completed', {
        ctx: {} as never,
        sessionId: 'sess-1',
        status: 'done',
        iterations: 1,
        at: new Date().toISOString(),
        durationMs: 10,
      });
      expect(ledger.tail(1)[0]?.detail).toBe(
        'steered agent run completed successfully (agent_stall)',
      );
      await ledger.stop();

      const sanitized = sanitizeDecision(
        {
          type: 'ask_human',
          prompt: 'Secret prompt',
          options: [{ id: 'opt1', label: 'Secret label', consequence: 'Secret consequence' }],
        },
        'none',
      );
      expect(sanitized).toEqual({
        type: 'ask_human',
        prompt: '',
        rationale: undefined,
        options: [{ id: 'opt1', label: 'opt1', consequence: undefined }],
      });

      const recorder = new BrainTraceRecorder({
        events,
        filePath: join(dir, 'trace.jsonl'),
      });
      recorder.start();
      recorder.start();
      const req = request({ id: 'req-trace-f105' });
      events.emit('brain.decision_requested', { at: 1000, sessionId: 'sess-1', request: req });
      events.emit('brain.tier_transition', {
        requestId: req.id,
        tier: 'rule',
        outcome: 'answer',
        terminal: true,
        at: 1005,
      });
      events.emit('brain.decision_answered', {
        at: 1010,
        sessionId: 'sess-1',
        request: req,
        decision: { type: 'answer', text: 'A' },
        tier: 'rule',
      });
      await recorder.stop();
      const traces = await readBrainTrace(join(dir, 'trace.jsonl'));
      expect(traces).toHaveLength(1);
      expect(traces[0]?.steps).toHaveLength(1);

      const compiled = compileBrainRules([
        {
          id: 'fractional-hits',
          when: { source: 'goal' },
          // biome-ignore lint/suspicious/noThenProperty: BrainRule DSL
          then: { action: 'deny' },
          maxHits: 0.5,
        },
        {
          id: 'inverted-risk',
          when: { minRisk: 'high', maxRisk: 'low' },
          // biome-ignore lint/suspicious/noThenProperty: BrainRule DSL
          then: { action: 'deny' },
        },
      ]);
      expect(compiled.rules).toHaveLength(0);
      expect(compiled.errors).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('guards BrainDecisionCache and BrainDecisionLedger against non-positive/NaN bounds and malformed JSONL rows (F151)', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    let clock = 1000;
    const nanCache = new BrainDecisionCache({
      enabled: true,
      ttlMs: Number.NaN,
      maxEntries: 0,
      now: () => clock,
    });
    nanCache.set(
      request({ id: 'c1' }),
      { type: 'answer', optionId: 'approve', text: 'Approve' },
      'llm',
    );
    expect(nanCache.get(request({ id: 'c2' }))?.type).toBe('answer');
    clock += 10_000_000;
    expect(nanCache.get(request({ id: 'c3' }))).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'brain-f151-'));
    try {
      const ledgerPath = join(dir, 'ledger.jsonl');
      await writeFile(
        ledgerPath,
        [
          JSON.stringify({
            at: 1000,
            requestId: 'valid-1',
            kind: 'answered',
            source: 'system',
            question: 'Evaluate the proposed action.',
            optionId: 'approve',
          }),
          '{"at":null,"requestId":"bad-null","kind":"answered","source":"system","question":"Evaluate the proposed action."}',
          '{"at":2000,"requestId":"   ","kind":"answered","source":"system","question":"Evaluate the proposed action."}',
        ].join('\n') + '\n',
        'utf8',
      );
      const events = new EventBus();
      const ledger = new BrainDecisionLedger({
        events,
        filePath: ledgerPath,
        maxMemoryEntries: 0,
        interventionRetryWindowMs: Number.NaN,
        now: () => 5000,
      });
      await ledger.start();
      expect(ledger.tail(10)).toHaveLength(1);
      events.emit('brain.decision_answered', {
        at: Number.NaN,
        request: request({ id: 'nan-at' }),
        decision: { type: 'answer', optionId: 'approve', text: 'Approve' },
      });
      expect(ledger.digestFor(request({ id: 'query' })) ?? '').not.toContain('NaN');

      const guard = createLedgerGuardBrainArbiter({
        failureStreakFor: (r) => ledger.failureStreakFor(r),
        denyAfter: Number.NaN,
        inner: {
          decide: async () => ({ type: 'answer', optionId: 'approve', text: 'Approve' }),
        },
      });
      expect((await guard.decide(request({ id: 'g1' }))).type).toBe('answer');
      await ledger.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
