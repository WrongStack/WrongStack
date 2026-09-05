import { describe, expect, it, vi } from 'vitest';
import type { BrainDecision, BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  createAutonomyBrain,
  extractConfidence,
  formatDecisionSummary,
  isNonAnswer,
  parseFreeTextDecision,
  readLlmDenyKind,
  resolveRiskCeiling,
} from '../../src/execution/autonomy-brain.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Provider } from '../../src/types/provider.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'goal',
  question: 'Should we continue?',
  risk: 'low',
  fallback: 'continue',
  ...over,
});

/** A fake provider whose complete() returns a content-block response. */
function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as never as Provider;
}

function throwingProvider(): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => {
      throw new Error('LLM down');
    }),
  } as never as Provider;
}

describe('resolveRiskCeiling', () => {
  it("maps 'all' above critical so nothing is gated out", () => {
    expect(resolveRiskCeiling('all')).toBeGreaterThanOrEqual(3);
  });

  it("maps 'off' below the lowest request risk so everything is gated out", () => {
    expect(resolveRiskCeiling('off')).toBeLessThan(0);
  });

  it('maps the named levels onto the request-risk scale', () => {
    expect(resolveRiskCeiling('low')).toBe(0);
    expect(resolveRiskCeiling('medium')).toBe(1);
    expect(resolveRiskCeiling('high')).toBe(2);
  });

  it("defaults to 'medium' when the ceiling is absent", () => {
    expect(resolveRiskCeiling(undefined)).toBe(resolveRiskCeiling('medium'));
  });
});

describe('createAutonomyBrain — risk gate', () => {
  // Regression: `RISK_LEVELS` is keyed by request risk and has no 'all' entry,
  // so looking the ceiling up directly resolved 'all' to the fallback level 2
  // (= high) and auto-denied every critical request. `assembleBrainTiers`
  // passes 'all' precisely to keep the inner tier ungated, so this silently
  // put critical decisions out of the LLM tier's reach entirely.
  it("does NOT deny a critical request when maxAutoRisk is 'all'", async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('Continue execution.'),
      model: 'm',
      maxAutoRisk: 'all',
    });
    const decision = await brain.decide(
      req({ risk: 'critical', question: 'Drop the staging schema?', fallback: 'deny' }),
    );
    expect(decision.type).toBe('answer');
  });

  it('still denies a critical request one level below (high)', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('Continue execution.'),
      model: 'm',
      maxAutoRisk: 'high',
    });
    const decision = await brain.decide(req({ risk: 'critical' }));
    expect(decision.type).toBe('deny');
  });
});

describe('llm deny kinds', () => {
  it('tags a dead pool as unavailable, not as a decision', async () => {
    const brain = createAutonomyBrain({
      provider: throwingProvider(),
      model: 'm',
      maxAutoRisk: 'all',
    });
    const decision = await brain.decide(req({ risk: 'high', fallback: 'deny' }));
    expect(decision.type).toBe('deny');
    expect(readLlmDenyKind(decision)).toBe('unavailable');
  });

  it('tags an unmatched option id as unparseable', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('I would rather not say.'),
      model: 'm',
      maxAutoRisk: 'all',
    });
    const decision = await brain.decide(
      req({
        risk: 'high',
        fallback: 'deny',
        options: [{ id: 'go', label: 'Go' }],
      }),
    );
    expect(decision.type).toBe('deny');
    expect(readLlmDenyKind(decision)).toBe('unparseable');
  });

  it('leaves non-LLM denials untagged so callers treat them as decided', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('x'),
      model: 'm',
      maxAutoRisk: 'low',
    });
    const decision = await brain.decide(req({ risk: 'critical' }));
    expect(decision.type).toBe('deny');
    expect(readLlmDenyKind(decision)).toBeUndefined();
  });
});

describe('createAutonomyBrain — risk gate', () => {
  it('auto-denies a request above the max risk and reports via onDecision', async () => {
    const onDecision = vi.fn();
    const brain = createAutonomyBrain({
      provider: fakeProvider('x'),
      model: 'm',
      maxAutoRisk: 'low',
      onDecision,
    });
    const decision = await brain.decide(req({ risk: 'high', question: 'Delete prod DB?' }));
    expect(decision.type).toBe('deny');
    expect(onDecision).toHaveBeenCalledWith(
      expect.stringContaining('DENIED'),
      decision,
      expect.any(Object),
    );
  });

  it('treats an unknown risk as high (default level 2)', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('x'),
      model: 'm',
      maxAutoRisk: 'low',
    });
    const decision = await brain.decide(req({ risk: 'bogus' as never, question: 'weird' }));
    expect(decision.type).toBe('deny');
  });
});

describe('createAutonomyBrain — heuristics (quickDecide)', () => {
  it('skips deadlocked tasks blocked by failed dependencies', async () => {
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm' });
    const d = await brain.decide(req({ question: 'deadlock detected', context: 'failed tasks' }));
    expect(d).toMatchObject({ type: 'answer' });
    if (d.type === 'answer') expect(d.text).toContain('Skip deadlocked');
  });

  it('moves on when retries are exhausted', async () => {
    const brain = createAutonomyBrain({ provider: fakeProvider('x'), model: 'm' });
    const d = await brain.decide(
      req({ question: 'task failed again', context: 'retries exhausted' }),
    );
    if (d.type === 'answer') expect(d.text).toContain('Mark as failed');
  });

  it('answers yes to a plain continue/proceed question without calling the LLM', async () => {
    const provider = fakeProvider('should not be called');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'Continue with phase 3?' }));
    expect(d).toMatchObject({ type: 'answer' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('routes goal-completion questions to the LLM (heuristic returns null)', async () => {
    const provider = fakeProvider('Continue execution. Progress is steady.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'Is the goal complete?', risk: 'medium' }));
    expect(provider.complete).toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer' });
  });

  it('never fires heuristics on option-bearing requests', async () => {
    const provider = fakeProvider('{"optionId":"go","rationale":"fine"}');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'Continue with phase 3?',
        options: [
          { id: 'go', label: 'Continue' },
          { id: 'wait', label: 'Wait' },
        ],
      }),
    );
    expect(provider.complete).toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer', optionId: 'go' });
  });

  it('sends "continue or stop" style questions to the LLM instead of auto-continuing', async () => {
    const provider = fakeProvider('Stop: the budget is exhausted and progress is zero.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'Should we continue or stop the run?' }));
    expect(provider.complete).toHaveBeenCalled();
    if (d.type === 'answer') expect(d.text).toContain('Stop');
  });

  it('does not auto-continue when the caller did not declare continue as fallback', async () => {
    const provider = fakeProvider('Evaluated: proceed carefully.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    await brain.decide(req({ question: 'Continue with phase 3?', fallback: 'deny' }));
    expect(provider.complete).toHaveBeenCalled();
  });
});

describe('createAutonomyBrain — LLM evaluation (llmDecide)', () => {
  it('matches a provided option id from the LLM text', async () => {
    const provider = fakeProvider('I choose [resolve] — safe to auto-resolve.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'resolve', label: 'Resolve conflict' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(d).toMatchObject({
      type: 'deny',
      reason: 'Autonomy Brain returned no exact valid option id.',
    });
  });

  it('accepts the canonical JSON option envelope', async () => {
    const provider = fakeProvider('{"optionId":"resolve","rationale":"Safe to auto-resolve."}');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'resolve', label: 'Resolve conflict' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(d).toMatchObject({
      type: 'answer',
      optionId: 'resolve',
      text: 'Resolve conflict',
      rationale: 'Safe to auto-resolve.',
    });
  });

  it('keeps the historical leading [id] option form for compatibility', async () => {
    const provider = fakeProvider('[resolve] — safe to auto-resolve.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'resolve', label: 'Resolve conflict' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'resolve', text: 'Resolve conflict' });
  });

  it('does not select an option merely mentioned in negated prose', async () => {
    const provider = fakeProvider('Do not spawn another helper; wait for current workers.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'spawn', label: 'Spawn helper' },
          { id: 'wait', label: 'Wait' },
        ],
      }),
    );
    expect(d).toMatchObject({
      type: 'deny',
      reason: 'Autonomy Brain returned no exact valid option id.',
    });
  });

  it('does not extract an option JSON block embedded in prose', async () => {
    const provider = fakeProvider(
      'Do not spawn; this is only an example:\n```json\n{"optionId":"spawn"}\n```',
    );
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'mission complete?',
        options: [
          { id: 'spawn', label: 'Spawn helper' },
          { id: 'wait', label: 'Wait' },
        ],
      }),
    );
    expect(d).toMatchObject({
      type: 'deny',
      reason: 'Autonomy Brain returned no exact valid option id.',
    });
  });

  it('sends the file-backed Autonomy Brain system prompt to the provider', async () => {
    const provider = fakeProvider('Continue execution.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    await brain.decide(req({ question: 'goal complete?', risk: 'medium' }));
    const request = vi.mocked(provider.complete).mock.calls[0]?.[0] as {
      system?: Array<{ text?: string }>;
    };
    const systemText = request.system?.[0]?.text ?? '';
    expect(systemText).toContain('You are the Autonomy Brain');
    expect(systemText).toContain('Your output is a DECISION');
  });

  it('returns a free-text answer when no option matches', async () => {
    const provider = fakeProvider('Continue, progress looks good.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete check', risk: 'medium' }));
    if (d.type === 'answer') expect(d.text).toContain('Continue');
  });

  it('refuses to turn an empty LLM response into a decision', async () => {
    const provider = fakeProvider('   ');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    // An empty response is not a judgement. It used to be dressed up as
    // "Continue execution." — indistinguishable from a real decision to the
    // caller. Now it is an `unparseable` deny, which the tiered arbiter
    // treats as "this tier could not decide" and hands to the next one.
    expect(d.type).toBe('deny');
    expect(readLlmDenyKind(d)).toBe('unparseable');
  });

  it('still produces the legacy continue text when the uncertainty gate is off', async () => {
    const provider = fakeProvider('   ');
    const brain = createAutonomyBrain({ provider, model: 'm', rejectUncertain: false });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    expect(d).toMatchObject({ type: 'answer', text: 'Continue execution.' });
  });

  it('falls back to denial text when the LLM returns empty and fallback is not continue', async () => {
    const provider = fakeProvider('');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'mission complete?', fallback: 'deny' }));
    if (d.type === 'answer') expect(d.text).toContain('Denied by autonomy policy');
  });

  it('reports an unreachable provider as unavailable, not as a continue answer', async () => {
    const brain = createAutonomyBrain({ provider: throwingProvider(), model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    // A dead pool did not decide anything. Synthesising a continue ANSWER here
    // made the tiered ladder credit a model that was never reached (and
    // skipped the uncertainty gate). The ladder still produces the same
    // continue — from the policy tier, which is what actually decided.
    expect(d.type).toBe('deny');
    expect(readLlmDenyKind(d)).toBe('unavailable');
  });

  it('denies when the provider throws and fallback is not continue', async () => {
    const brain = createAutonomyBrain({ provider: throwingProvider(), model: 'm' });
    const d = await brain.decide(req({ question: 'mission complete?', fallback: 'deny' }));
    expect(d).toMatchObject({ type: 'deny' });
  });

  it('falls through to the LLM for a question matching no heuristic pattern', async () => {
    const provider = fakeProvider('Resolve it.');
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({ question: 'How should we handle the merge conflict?', risk: 'medium' }),
    );
    expect(provider.complete).toHaveBeenCalled(); // quickDecide returned null → LLM
    expect(d).toMatchObject({ type: 'answer' });
  });

  it('reads a bare {text} response shape', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => ({ text: 'Continue from the text field.' })),
    } as never as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', risk: 'medium' }));
    if (d.type === 'answer') expect(d.text).toContain('text field');
  });

  it('handles a non-object provider response (extractText guard)', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => null),
    } as never as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(req({ question: 'goal complete?', fallback: 'continue' }));
    // An unrecognised provider shape extracts to empty text, which is a
    // transport/compat problem — not evidence that continuing is correct.
    expect(d.type).toBe('deny');
    expect(readLlmDenyKind(d)).toBe('unparseable');
  });

  it('reads a choices-style (OpenAI) response shape and renders option consequences/recommended', async () => {
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => ({ choices: [{ message: { content: '[a] — safe' } }] })),
    } as never as Provider;
    const brain = createAutonomyBrain({ provider, model: 'm' });
    const d = await brain.decide(
      req({
        question: 'goal complete?',
        options: [
          { id: 'a', label: 'Option A', consequence: 'safe', recommended: true },
          { id: 'b', label: 'Option B' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'a' });
  });
});

describe('formatDecisionSummary', () => {
  it('formats a denial', () => {
    const d: BrainDecision = { type: 'deny', reason: 'too risky' };
    expect(formatDecisionSummary(d, req())).toContain('DENIED');
  });

  it('formats an option-id answer, a long-text answer, and a short-text answer', () => {
    expect(formatDecisionSummary({ type: 'answer', optionId: 'x', text: 'X' }, req())).toContain(
      'chose [x]',
    );
    const long = 'y'.repeat(100);
    expect(formatDecisionSummary({ type: 'answer', text: long }, req())).toContain('…');
    expect(formatDecisionSummary({ type: 'answer', text: 'short' }, req())).toContain('short');
  });

  it('formats an ask_human decision and truncates a long question', () => {
    const longQ = 'Q'.repeat(100);
    const out = formatDecisionSummary({ type: 'ask_human', prompt: 'p' }, req({ question: longQ }));
    expect(out).toContain('ASKED HUMAN');
    expect(out).toContain('…');
  });
});

describe('LLM quality gate', () => {
  const goal = req({ question: 'goal complete?', fallback: 'continue' });

  it('rejects a hedging response instead of presenting it as an answer', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider("I don't know — there is not enough context to say."),
      model: 'm',
    });
    const d = await brain.decide(goal);
    expect(d.type).toBe('deny');
    expect(readLlmDenyKind(d)).toBe('unparseable');
  });

  it('accepts the structured envelope and keeps its rationale', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider(
        '{"decision":"Continue execution.","rationale":"3/5 deliverables done.","confidence":0.9}',
      ),
      model: 'm',
    });
    const d = await brain.decide(goal);
    expect(d).toMatchObject({
      type: 'answer',
      text: 'Continue execution.',
      rationale: '3/5 deliverables done.',
    });
  });

  it('still accepts bare prose for compatibility', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('Continue execution. Progress is steady.'),
      model: 'm',
    });
    expect(await brain.decide(goal)).toMatchObject({ type: 'answer' });
  });

  it('rejects an answer below the confidence floor', async () => {
    const provider = fakeProvider('{"decision":"Ship it.","confidence":0.2}');
    const strict = createAutonomyBrain({ provider, model: 'm', minConfidence: 0.7 });
    const d = await strict.decide(goal);
    expect(d.type).toBe('deny');
    expect(d.type === 'deny' && d.reason).toContain('confidence');

    // Same response passes when no floor is configured (the default).
    const lenient = createAutonomyBrain({ provider, model: 'm' });
    expect(await lenient.decide(goal)).toMatchObject({ type: 'answer', text: 'Ship it.' });
  });

  it('never rejects a response that reports no confidence at all', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('{"decision":"Continue execution."}'),
      model: 'm',
      minConfidence: 0.9,
    });
    expect(await brain.decide(goal)).toMatchObject({ type: 'answer' });
  });

  it('applies the confidence floor to option-bearing decisions too', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('{"optionId":"go","confidence":0.1}'),
      model: 'm',
      minConfidence: 0.5,
    });
    const d = await brain.decide(
      req({ fallback: 'continue', options: [{ id: 'go', label: 'Go' }] }),
    );
    expect(d.type).toBe('deny');
  });
});

describe('isNonAnswer / parseFreeTextDecision / extractConfidence', () => {
  it('detects declines but not ordinary decisions', () => {
    expect(isNonAnswer('')).toBe(true);
    expect(isNonAnswer('insufficient evidence')).toBe(true);
    expect(isNonAnswer('Cannot determine from the given context.')).toBe(true);
    expect(isNonAnswer('Please clarify the deliverable list.')).toBe(true);
    expect(isNonAnswer('Continue execution. Progress is steady.')).toBe(false);
    // "unclear" as a whole word is a decline; inside another word it is not.
    expect(isNonAnswer('The requirement is unclear')).toBe(true);
    expect(isNonAnswer('Skip the nuclearplant task')).toBe(false);
  });

  it('returns null for a declined structured envelope', () => {
    expect(parseFreeTextDecision('{"decision":"insufficient evidence","confidence":0}')).toBeNull();
  });

  it('clamps confidence into 0..1', () => {
    expect(extractConfidence('{"confidence":5}')).toBe(1);
    expect(extractConfidence('{"confidence":-2}')).toBe(0);
    expect(extractConfidence('no json here')).toBeUndefined();
    expect(extractConfidence('```json\n{"confidence":0.5}\n```')).toBe(0.5);
  });
});

/** A request `quickDecide` will not short-circuit, so the LLM tier runs. */
const llmReq = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest =>
  req({ question: 'goal complete?', fallback: 'continue', ...over });

describe('single-LLM tier — call shape and budgets', () => {
  /** Captures the Request the provider was handed. */
  function recordingProvider(text: string, stopReason?: string) {
    const calls: Array<Record<string, unknown>> = [];
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async (request: Record<string, unknown>) => {
        calls.push(request);
        return { content: [{ type: 'text', text }], ...(stopReason ? { stopReason } : {}) };
      }),
    } as never as Provider;
    return { provider, calls };
  }

  it('asks for JSON on the wire, not only in the prompt', async () => {
    const { provider, calls } = recordingProvider('{"decision":"Ship it."}');
    await createAutonomyBrain({ provider, model: 'm' }).decide(llmReq());
    // The system prompt demands "exactly one JSON object"; reasoning-heavy
    // models ignore prose instructions that are not backed on the wire.
    expect(calls[0]?.responseFormat).toEqual({ type: 'json_object' });
  });

  it('budgets enough output for a reasoning model to think', async () => {
    const { provider, calls } = recordingProvider('{"decision":"Ship it."}');
    await createAutonomyBrain({ provider, model: 'm' }).decide(llmReq());
    // 200 was sized for the response, not the budget: thinking tokens come
    // out of the same allowance and starve the answer into `unparseable`.
    expect(calls[0]?.maxTokens).toBe(2000);
  });

  it('honours an explicit maxTokens override', async () => {
    const { provider, calls } = recordingProvider('{"decision":"Ship it."}');
    await createAutonomyBrain({ provider, model: 'm', maxTokens: 128 }).decide(llmReq());
    expect(calls[0]?.maxTokens).toBe(128);
  });

  it('names truncation in the deny reason instead of reporting a bare parse failure', async () => {
    const { provider } = recordingProvider('{"decis', 'max_tokens');
    const d = await createAutonomyBrain({ provider, model: 'm' }).decide(
      llmReq({ options: [{ id: 'go', label: 'Go' }] }),
    );
    expect(d.type).toBe('deny');
    expect(d.type === 'deny' && d.reason).toContain('truncated at maxTokens=2000');
  });

  it('flags a truncated call as ok-but-truncated on the trace event', async () => {
    const { provider } = recordingProvider('{"decis', 'max_tokens');
    const events = new EventBus();
    const rows: Array<{ ok?: boolean; truncated?: boolean; error?: string }> = [];
    events.on('brain.llm_call', (e) => rows.push(e as never));
    await createAutonomyBrain({ provider, model: 'm', events }).decide(llmReq());
    expect(rows[0]).toMatchObject({ ok: true, truncated: true });
    // `error` belongs to failed rows; a truncated call reached the provider.
    expect(rows[0]?.error).toBeUndefined();
  });

  it('stops walking a dead pool once the decision budget is spent', async () => {
    const attempted: string[] = [];
    /** Hangs until aborted, so each attempt burns exactly its per-call budget. */
    const hangingTarget = (model: string) => ({
      provider: {
        id: model,
        capabilities: {},
        stream: vi.fn(),
        complete: vi.fn(
          (_request: unknown, opts?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              attempted.push(model);
              opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      } as never as Provider,
      model,
    });

    const brain = createAutonomyBrain({
      targets: ['a', 'b', 'c', 'd', 'e'].map(hangingTarget),
      decisionTimeoutMs: 30,
    });
    const d = await brain.decide(llmReq());

    expect(d.type).toBe('deny');
    expect(d.type === 'deny' && d.reason).toContain('decision budget');
    // The cap is wall clock (deadline = 3 x per-call timeout), so the exact
    // attempt where the walk stops is scheduler-dependent: AbortSignal.timeout
    // and the Date.now() budget check run on different clocks, and under load
    // a 4th attempt can start a fraction of a millisecond before the deadline
    // and abort almost immediately. 3 is the deterministic window, 4 the
    // boundary race; anything else means the budget or the walk broke.
    expect(attempted.length).toBeGreaterThanOrEqual(3);
    expect(attempted.length).toBeLessThan(5);
    expect(attempted).toEqual(['a', 'b', 'c', 'd'].slice(0, attempted.length));
  });
});

describe('confidence floor is independent of the uncertainty gate', () => {
  it('rejects a low-confidence optionless answer even with rejectUncertain off', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('{"decision":"Ship it.","confidence":0.1}'),
      model: 'm',
      rejectUncertain: false,
      minConfidence: 0.7,
    });
    const d = await brain.decide(llmReq());
    // Option-bearing requests always enforced the floor; optionless ones
    // silently skipped it whenever the uncertainty gate was off.
    expect(d.type).toBe('deny');
    expect(d.type === 'deny' && d.reason).toContain('confidence');
  });

  it('still allows the legacy wrap-anything behaviour when confidence is absent', async () => {
    const brain = createAutonomyBrain({
      provider: fakeProvider('   '),
      model: 'm',
      rejectUncertain: false,
    });
    await expect(brain.decide(llmReq())).resolves.toMatchObject({
      type: 'answer',
      text: 'Continue execution.',
    });
  });
});
