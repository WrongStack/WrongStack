import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ObservableBrainArbiter,
  type BrainDecision,
  type BrainDecisionRequest,
} from '../../src/coordination/brain.js';
import { markDecisionTier } from '../../src/coordination/brain-telemetry.js';
import {
  applyContentMode,
  BrainTraceRecorder,
  readBrainTrace,
  sanitizeRequest,
} from '../../src/coordination/brain-trace.js';
import {
  brainTraceToEvaluationCase,
  runBrainEvaluation,
} from '../../src/execution/brain-evaluation.js';
import { EventBus } from '../../src/kernel/events.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'req-1',
  sessionId: 's1',
  source: 'director',
  question: 'Extend the subagent budget?',
  context: 'Spent 80% of the token budget at 60% progress.',
  risk: 'high',
  fallback: 'deny',
  ...over,
});

describe('applyContentMode / sanitizeRequest', () => {
  it('drops free text in none mode but keeps replayable structure', () => {
    const sanitized = sanitizeRequest(
      req({ options: [{ id: 'extend', label: 'Extend it', consequence: 'costs more' }] }),
      'none',
    );
    expect(sanitized.context).toBeUndefined();
    expect(sanitized.question).toBe('[redacted]');
    // Structure survives: ids, risk and fallback are what make a fixture runnable.
    expect(sanitized.risk).toBe('high');
    expect(sanitized.fallback).toBe('deny');
    expect(sanitized.options?.[0]?.id).toBe('extend');
    expect(sanitized.options?.[0]?.label).toBe('extend');
  });

  it('truncates in redacted mode and preserves everything in full mode', () => {
    const long = 'x'.repeat(500);
    expect(applyContentMode(long, 'redacted')?.length).toBeLessThan(long.length);
    expect(applyContentMode(long, 'full')).toBe(long);
    expect(applyContentMode(long, 'none')).toBeUndefined();
  });

  // WS-063: `redacted` used to *only* truncate. A key pasted into a Brain
  // question sits inside the first 120 characters, so the mode named
  // "redacted" wrote it to the trace file verbatim.
  it('redacts credentials in redacted mode, not just length', () => {
    const withKey = 'deploy using sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ now';
    const out = applyContentMode(withKey, 'redacted');
    expect(out).toBeDefined();
    expect(out).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
    expect(out).toContain('deploy using');
  });

  it('scrubs before truncating, so the cut cannot leave a half-redacted token', () => {
    const padded = `${'a'.repeat(100)} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
    const out = applyContentMode(padded, 'redacted') ?? '';
    // The truncation point falls inside where the raw token would have been.
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('leaves full mode unscrubbed — a replay fixture needs the real text', () => {
    const withKey = 'sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';
    expect(applyContentMode(withKey, 'full')).toBe(withKey);
  });
});

describe('BrainTraceRecorder', () => {
  let dir: string;
  let file: string;
  let events: EventBus;
  let recorder: BrainTraceRecorder;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'brain-trace-'));
    file = join(dir, 'brain-trace.jsonl');
    events = new EventBus();
    recorder = new BrainTraceRecorder({ events, filePath: file });
    recorder.start();
  });

  afterEach(async () => {
    await recorder.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** Drive a full decision's worth of events through the bus. */
  const emitDecision = (request: BrainDecisionRequest, decision: BrainDecision) => {
    events.emit('brain.decision_requested', { sessionId: request.sessionId, request, at: 1_000 });
    events.emit('brain.tier_transition', {
      sessionId: request.sessionId,
      requestId: request.id,
      tier: 'policy',
      outcome: 'ask_human',
      terminal: false,
      reason: 'policy escalated',
      durationMs: 1,
      at: 1_001,
    });
    events.emit('brain.llm_call', {
      sessionId: request.sessionId,
      requestId: request.id,
      tier: 'llm',
      providerId: 'p1',
      model: 'dead-model',
      attempt: 0,
      ok: false,
      durationMs: 15_000,
      error: 'timeout',
      at: 1_002,
    });
    events.emit('brain.llm_call', {
      sessionId: request.sessionId,
      requestId: request.id,
      tier: 'llm',
      providerId: 'p2',
      model: 'good-model',
      attempt: 1,
      ok: true,
      durationMs: 400,
      responseText: 'Continue.',
      usage: { input: 120, output: 30 },
      at: 1_003,
    });
    events.emit('brain.decision_answered', {
      sessionId: request.sessionId,
      request,
      decision,
      at: 2_000,
      tier: 'llm',
    });
  };

  it('correlates a decision into one replayable record', async () => {
    const request = req();
    emitDecision(request, { type: 'answer', text: 'Continue.', rationale: 'Progress is steady.' });
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    expect(record).toBeDefined();
    expect(record?.requestId).toBe('req-1');
    expect(record?.tier).toBe('llm');
    expect(record?.durationMs).toBe(1_000);
    expect(record?.steps).toHaveLength(1);
    expect(record?.llmCalls).toHaveLength(2);
  });

  it('records the pool failure the fallback loop would otherwise swallow', async () => {
    emitDecision(req(), { type: 'answer', text: 'Continue.' });
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    const failed = record?.llmCalls.find((c) => !c.ok);
    expect(failed).toMatchObject({ model: 'dead-model', attempt: 0, error: 'timeout' });
    expect(record?.totals.failedLlmCalls).toBe(1);
    expect(record?.totals.llmCalls).toBe(2);
  });

  it('aggregates token usage across provider calls', async () => {
    emitDecision(req(), { type: 'answer', text: 'Continue.' });
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    expect(record?.totals).toMatchObject({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  });

  it('captures council votes and the deterministic resolution', async () => {
    const request = req({ id: 'req-council' });
    events.emit('brain.decision_requested', { request, at: 1_000 });
    events.emit('brain.council_vote', {
      requestId: request.id,
      seatId: 'voter-1',
      persona: 'skeptic',
      status: 'valid',
      model: 'm2',
      optionId: '__refuse__',
      rationale: 'Budget already overspent.',
      veto: true,
      at: 1_100,
    });
    events.emit('brain.council_resolved', {
      requestId: request.id,
      status: 'denied',
      resolution: 'veto',
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 3,
      judgeUsed: false,
      usage: { calls: 3, inputTokens: 300, outputTokens: 60, totalTokens: 360, durationMs: 900 },
      at: 1_200,
    });
    events.emit('brain.decision_denied', {
      request,
      decision: { type: 'deny', reason: 'Council vetoes' },
      at: 1_300,
      tier: 'council',
    });
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    expect(record?.councilVotes[0]).toMatchObject({ seatId: 'voter-1', veto: true });
    expect(record?.councilResolution).toMatchObject({ resolution: 'veto', judgeUsed: false });
    // Council usage folds into the same totals as single-LLM calls.
    expect(record?.totals.totalTokens).toBe(360);
  });

  it('honours the content mode when writing', async () => {
    await recorder.stop();
    const quiet = new BrainTraceRecorder({ events, filePath: file, content: 'none' });
    quiet.start();
    emitDecision(req(), { type: 'answer', text: 'Continue.', rationale: 'secret reasoning' });
    await quiet.stop();

    const [record] = await readBrainTrace(file);
    expect(record?.request.context).toBeUndefined();
    expect(record?.llmCalls.find((c) => c.ok)?.responseText).toBeUndefined();
    // Metadata still answers "what is the LLM doing".
    expect(record?.llmCalls.find((c) => c.ok)?.model).toBe('good-model');
    expect(record?.totals.totalTokens).toBe(150);
  });

  it('bounds open records so an unresolved decision cannot leak', () => {
    for (let i = 0; i < 10; i++) {
      events.emit('brain.decision_requested', { request: req({ id: `open-${i}` }), at: i });
    }
    expect(recorder.openCount).toBe(10);

    const bounded = new BrainTraceRecorder({ events, filePath: file, maxOpenRecords: 3 });
    bounded.start();
    for (let i = 0; i < 10; i++) {
      events.emit('brain.decision_requested', { request: req({ id: `leak-${i}` }), at: i });
    }
    expect(bounded.openCount).toBe(3);
    void bounded.stop();
  });

  it('ignores events for decisions it never saw start', async () => {
    events.emit('brain.llm_call', {
      requestId: 'never-started',
      tier: 'llm',
      model: 'm',
      attempt: 0,
      ok: true,
      durationMs: 1,
      at: 1,
    });
    events.emit('brain.decision_answered', {
      request: req({ id: 'never-started' }),
      decision: { type: 'answer', text: 'x' },
      at: 2,
    });
    await recorder.stop();
    expect(await readBrainTrace(file)).toEqual([]);
  });

  it('reads the tier recorded inside the chain via ObservableBrainArbiter', async () => {
    const observable = new ObservableBrainArbiter(
      {
        decide: async (request) => {
          markDecisionTier(request, 'rule');
          return { type: 'answer', text: 'from a rule' };
        },
      },
      events,
    );
    await observable.decide(req({ id: 'req-observable' }));
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    expect(record?.tier).toBe('rule');
    // A rule decision costs nothing — that is the number worth watching.
    expect(record?.totals.llmCalls).toBe(0);
  });
});

describe('brainTraceToEvaluationCase', () => {
  it('produces a fixture that replays through runBrainEvaluation', async () => {
    const events = new EventBus();
    const dir = await mkdtemp(join(tmpdir(), 'brain-trace-'));
    const file = join(dir, 't.jsonl');
    const recorder = new BrainTraceRecorder({ events, filePath: file });
    recorder.start();

    const request = req({
      options: [
        { id: 'extend', label: 'Extend' },
        { id: 'stop', label: 'Stop' },
      ],
    });
    events.emit('brain.decision_requested', { request, at: 1 });
    events.emit('brain.decision_answered', {
      request,
      decision: { type: 'answer', optionId: 'extend', text: 'Extend' },
      at: 2,
      tier: 'council',
    });
    await recorder.stop();

    const [record] = await readBrainTrace(file);
    expect(record).toBeDefined();
    if (!record) return;

    const fixture = brainTraceToEvaluationCase(record, { pinObservedDecision: true });
    expect(fixture.id).toBe('capture-req-1');
    expect(fixture.expectations).toMatchObject({
      allowedOptionIds: ['extend'],
      requireOptionId: true,
    });

    // Replaying an arbiter that reproduces the decision passes; one that
    // picks the other option fails the pinned expectation.
    const same = await runBrainEvaluation(
      { decide: async () => ({ type: 'answer', optionId: 'extend', text: 'Extend' }) },
      [fixture],
    );
    expect(same.metrics.passedCases).toBe(1);

    const drifted = await runBrainEvaluation(
      { decide: async () => ({ type: 'answer', optionId: 'stop', text: 'Stop' }) },
      [fixture],
    );
    expect(drifted.metrics.failedCases).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves the case unpinned by default so capture is evidence, not a verdict', async () => {
    const record = {
      version: 1 as const,
      requestId: 'r',
      startedAt: 0,
      completedAt: 1,
      durationMs: 1,
      request: req(),
      decision: { type: 'answer' as const, optionId: 'extend', text: 'Extend' },
      steps: [],
      llmCalls: [],
      councilVotes: [],
      totals: { llmCalls: 0, failedLlmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const fixture = brainTraceToEvaluationCase(record);
    expect(fixture.expectations).toBeUndefined();
  });
});
