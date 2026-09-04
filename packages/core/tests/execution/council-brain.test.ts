import { describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  type BrainLlmTarget,
  completeBrainLlm,
  completeBrainLlmDetailed,
} from '../../src/execution/autonomy-brain.js';
import {
  COUNCIL_REFUSE_OPTION_ID,
  type CouncilVoter,
  createCouncilBrainArbiter,
  makeSeatCallerForVoter,
} from '../../src/execution/council-brain.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Provider } from '../../src/types/provider.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'c1',
  source: 'system',
  question: 'Should we merge the risky change?',
  risk: 'high',
  fallback: 'ask_human',
  options: [
    { id: 'merge', label: 'Merge it' },
    { id: 'hold', label: 'Hold for review' },
  ],
  ...over,
});

/** A provider whose complete() always returns the given text. */
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

/**
 * A provider whose complete() hangs until its signal aborts, then rejects.
 * Mirrors how real providers observe the abort signal; used to prove an
 * abort actually reaches an in-flight call (a dropped signal would hang the
 * test until its per-test timeout).
 */
function abortSensitiveProvider(): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async (_request: unknown, opts?: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        if (opts?.signal?.aborted) return reject(new Error('aborted'));
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      return { content: [{ type: 'text', text: 'done' }] };
    }),
  } as never as Provider;
}

const voter = (text: string, over: Partial<CouncilVoter> = {}): CouncilVoter => ({
  provider: fakeProvider(text),
  model: 'm',
  ...over,
});

const vote = (optionId: string, rationale = 'because') => JSON.stringify({ optionId, rationale });

describe('createCouncilBrainArbiter — weighted majority', () => {
  it('answers with the majority option without needing a judge', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge'), { persona: 'executor' }),
        voter(vote('merge'), { persona: 'auditor' }),
        voter(vote('hold'), { persona: 'skeptic' }),
      ],
    });
    const d = await council.decide(req());
    expect(d).toMatchObject({ type: 'answer', optionId: 'merge' });
    if (d.type === 'answer') expect(d.rationale).toContain('majority');
  });

  it('lets vote weight overrule seat count', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter(vote('hold'), { weight: 3 }), voter(vote('merge')), voter(vote('merge'))],
    });
    const d = await council.decide(req());
    expect(d).toMatchObject({ type: 'answer', optionId: 'hold' });
  });

  it('denies when the refuse option wins the tally', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote(COUNCIL_REFUSE_OPTION_ID)),
        voter(vote(COUNCIL_REFUSE_OPTION_ID)),
        voter(vote('merge')),
      ],
    });
    const d = await council.decide(req());
    expect(d.type).toBe('deny');
  });
});

describe('createCouncilBrainArbiter — veto', () => {
  it('a veto seat refusing denies outright even when outvoted', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge')),
        voter(vote('merge')),
        voter(vote(COUNCIL_REFUSE_OPTION_ID, 'unsafe premise'), {
          persona: 'skeptic',
          veto: true,
        }),
      ],
    });
    const d = await council.decide(req());
    expect(d.type).toBe('deny');
    if (d.type === 'deny') expect(d.reason).toContain('veto');
  });

  it('a non-veto refusal does NOT deny when a real option holds the majority', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge')),
        voter(vote('merge')),
        voter(vote(COUNCIL_REFUSE_OPTION_ID), { veto: false }),
      ],
    });
    const d = await council.decide(req());
    expect(d).toMatchObject({ type: 'answer', optionId: 'merge' });
  });
});

describe('createCouncilBrainArbiter — quorum + judge', () => {
  it('abstains (ask_human) when quorum is not met', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        { provider: throwingProvider(), model: 'm' },
        { provider: throwingProvider(), model: 'm' },
        voter(vote('merge')),
      ],
      quorumFraction: 0.5,
    });
    const d = await council.decide(req());
    expect(d.type).toBe('ask_human');
  });

  it('sends a tie to the judge and uses its verdict', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter(vote('merge')), voter(vote('hold'))],
      judge: { provider: fakeProvider(vote('hold', 'safer')), model: 'judge-m' },
    });
    const d = await council.decide(req());
    expect(d).toMatchObject({ type: 'answer', optionId: 'hold' });
    if (d.type === 'answer') expect(d.rationale).toBeTruthy();
  });

  it('abstains on a tie with no judge', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter(vote('merge')), voter(vote('hold'))],
    });
    const d = await council.decide(req());
    expect(d.type).toBe('ask_human');
  });

  it('abstains when the judge itself fails on a tie', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter(vote('merge')), voter(vote('hold'))],
      judge: { provider: throwingProvider(), model: 'judge-m' },
    });
    const d = await council.decide(req());
    expect(d.type).toBe('ask_human');
  });
});

describe('createCouncilBrainArbiter — optionless synthesis', () => {
  it('synthesizes the final answer through the judge', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter('Continue, progress is real.'), voter('Stop, the goal is done.')],
      judge: {
        provider: fakeProvider('The goal is complete; stop the run.'),
        model: 'judge-m',
      },
    });
    const d = await council.decide(req({ options: undefined }));
    expect(d).toMatchObject({ type: 'answer' });
    if (d.type === 'answer') expect(d.text).toContain('complete');
  });

  it('abstains when optionless stances diverge and no judge is configured', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter('Continue, progress is real.'), voter('Stop now.')],
    });
    const d = await council.decide(req({ options: undefined }));
    // Divergence is surfaced (ask_human) instead of first-stance-wins: with
    // no judge to reconcile free-text stances, the panel escalates rather
    // than silently letting the first seat's stance win.
    expect(d.type).toBe('ask_human');
  });

  it('decides on a single stance without a judge', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter('Continue, progress is real.')],
    });
    const d = await council.decide(req({ options: undefined }));
    expect(d).toMatchObject({ type: 'answer', text: 'Continue, progress is real.' });
  });

  it('abstains when no voter produces a stance', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        { provider: throwingProvider(), model: 'm' },
        { provider: throwingProvider(), model: 'm' },
      ],
    });
    const d = await council.decide(req({ options: undefined }));
    expect(d.type).toBe('ask_human');
  });
});

describe('createCouncilBrainArbiter — construction', () => {
  it('rejects an empty voter list', () => {
    expect(() => createCouncilBrainArbiter({ voters: [] as BrainLlmTarget[] })).toThrow(
      /at least one voter/,
    );
  });
});

describe('council trace emission', () => {
  it('re-emits every seat vote and the resolution onto the bus', async () => {
    const events = new EventBus();
    const votes: unknown[] = [];
    const resolutions: unknown[] = [];
    events.on('brain.council_vote', (e) => votes.push(e));
    events.on('brain.council_resolved', (e) => resolutions.push(e));

    const arbiter = createCouncilBrainArbiter({
      voters: [
        {
          provider: fakeProvider('{"optionId":"go","rationale":"safe"}'),
          model: 'm1',
          persona: 'executor',
        },
        {
          provider: fakeProvider('{"optionId":"go","rationale":"fine"}'),
          model: 'm2',
          persona: 'skeptic',
          veto: true,
        },
      ],
      events,
      traceContent: true,
    });

    await arbiter.decide({
      id: 'req-trace',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [
        { id: 'go', label: 'Go' },
        { id: 'stop', label: 'Stop' },
      ],
    });

    // Two seats x two deliberation rounds — every round is traced, because a
    // panel that converged is a different verdict from one that agreed.
    expect(votes).toHaveLength(4);
    expect(votes[0]).toMatchObject({ requestId: 'req-trace', seatId: 'voter-0', round: 1 });
    // Seat weight/veto come from the configured seats, not from the vote row.
    expect(votes[1]).toMatchObject({ seatId: 'voter-1', veto: true, round: 1 });
    expect(votes[2]).toMatchObject({ seatId: 'voter-0', round: 2 });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      requestId: 'req-trace',
      configuredSeatCount: 2,
      judgeUsed: false,
      rounds: 2,
      deliberationChanges: 0,
    });
  });

  it('names the judge on the resolution, and flags one that already voted', async () => {
    const events = new EventBus();
    const resolutions: Array<{ judgeLabel?: string; judgeIsVoter?: boolean }> = [];
    events.on('brain.council_resolved', (e) => resolutions.push(e as never));

    const seated = {
      provider: fakeProvider('{"optionId":"go","rationale":"safe"}'),
      model: 'm1',
      label: 'p/m1',
      persona: 'executor',
    };
    const arbiter = createCouncilBrainArbiter({
      voters: [
        seated,
        {
          provider: fakeProvider('{"optionId":"go","rationale":"fine"}'),
          model: 'm2',
          label: 'p/m2',
          persona: 'skeptic',
        },
      ],
      // The tie-breaker is voter #1 — the correlation the surfaces could not see.
      judge: { provider: seated.provider, model: 'm1', label: 'p/m1' },
      events,
    });

    await arbiter.decide({
      id: 'req-judge',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [{ id: 'go', label: 'Go' }],
    });

    expect(resolutions[0]?.judgeLabel).toBe('p/m1');
    expect(resolutions[0]?.judgeIsVoter).toBe(true);
  });

  it('reports a correlated panel through resolution warnings', async () => {
    // A council whose seats all resolve to the SAME model is an expensive way
    // to ask one model three times: the votes are correlated, so the majority
    // it produces is not the independent agreement the panel is meant to buy.
    // The orchestrator detects this, but the Brain adapter used to drop the
    // warnings, so the verdict looked indistinguishable from a real panel's.
    const events = new EventBus();
    const resolutions: Array<{ warnings?: string[]; distinctTargetCount?: number }> = [];
    events.on('brain.council_resolved', (e) => resolutions.push(e as never));

    const arbiter = createCouncilBrainArbiter({
      voters: [
        { provider: fakeProvider(vote('go')), model: 'same-model', persona: 'executor' },
        { provider: fakeProvider(vote('go')), model: 'same-model', persona: 'skeptic' },
      ],
      distinctness: 'model',
      events,
    });
    const d = await arbiter.decide({
      id: 'req-correlated',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [
        { id: 'go', label: 'Go' },
        { id: 'stop', label: 'Stop' },
      ],
    });

    // The decision itself is unaffected — this is an observability signal,
    // not a gate. Silently denying here would strand anyone with a
    // single-provider pool.
    expect(d).toMatchObject({ type: 'answer', optionId: 'go' });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.distinctTargetCount).toBe(1);
    expect(resolutions[0]?.warnings?.join(' ')).toContain('distinctness');
  });

  it('emits no warnings for a genuinely distinct panel', async () => {
    const events = new EventBus();
    const resolutions: Array<{ warnings?: string[] }> = [];
    events.on('brain.council_resolved', (e) => resolutions.push(e as never));

    const arbiter = createCouncilBrainArbiter({
      voters: [
        { provider: fakeProvider(vote('go')), model: 'model-a', persona: 'executor' },
        { provider: fakeProvider(vote('go')), model: 'model-b', persona: 'skeptic' },
      ],
      distinctness: 'model',
      events,
    });
    await arbiter.decide({
      id: 'req-distinct',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [{ id: 'go', label: 'Go' }],
    });

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.warnings).toBeUndefined();
  });

  it('omits vote rationales when trace content is off', async () => {
    const events = new EventBus();
    const votes: Array<{ rationale?: string }> = [];
    events.on('brain.council_vote', (e) => votes.push(e as never));

    const arbiter = createCouncilBrainArbiter({
      voters: [
        { provider: fakeProvider('{"optionId":"go","rationale":"secret"}'), model: 'm1' },
        { provider: fakeProvider('{"optionId":"go","rationale":"secret"}'), model: 'm2' },
      ],
      events,
    });
    await arbiter.decide({
      id: 'req-quiet',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [{ id: 'go', label: 'Go' }],
    });

    expect(votes.length).toBeGreaterThan(0);
    for (const vote of votes) expect(vote.rationale).toBeUndefined();
  });

  it('does not emit at all when no bus is wired', async () => {
    const arbiter = createCouncilBrainArbiter({
      voters: [
        { provider: fakeProvider('{"optionId":"go"}'), model: 'm1' },
        { provider: fakeProvider('{"optionId":"go"}'), model: 'm2' },
      ],
    });
    const decision = await arbiter.decide({
      id: 'req-nobus',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [{ id: 'go', label: 'Go' }],
    });
    expect(decision.type).toBe('answer');
  });
});

describe('createCouncilBrainArbiter — custom personas', () => {
  it('registers an unrecognized persona string as an ad-hoc lens instead of failing', async () => {
    const events = new EventBus();
    const votes: Array<{ persona?: string; status?: string }> = [];
    events.on('brain.council_vote', (e) =>
      votes.push({ persona: e.persona as string, status: e.status as string }),
    );
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge'), { persona: 'weigh latency above all else' }),
        voter(vote('merge'), { persona: 'skeptic' }),
      ],
      events,
    });

    const decision = await council.decide(req());

    // Before this was fixed the orchestrator threw "unknown persona", which the
    // tiered arbiter swallowed — the council silently never ran.
    expect(decision.type).toBe('answer');
    // Two seats x two deliberation rounds.
    expect(votes).toHaveLength(4);
    expect(votes.every((v) => v.status === 'valid')).toBe(true);
    expect(votes[0]?.persona).toBe('custom-weigh-latency-above-all-else');
    expect(votes[1]?.persona).toBe('skeptic');
  });

  it('sends the raw persona text to the voter as its decision lens', async () => {
    const provider = fakeProvider(vote('merge'));
    const council = createCouncilBrainArbiter({
      voters: [
        { provider, model: 'm', persona: 'optimize for reversibility' },
        voter(vote('merge'), { persona: 'auditor' }),
      ],
    });

    await council.decide(req());

    const call = (provider.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const request = call?.[0] as { system?: Array<{ text: string }> };
    const system = (request.system ?? []).map((b) => b.text).join('\n');
    expect(system).toContain('optimize for reversibility');
  });

  it('reuses one lens id when several seats share the same custom persona', async () => {
    const events = new EventBus();
    const personas: string[] = [];
    events.on('brain.council_vote', (e) => personas.push(e.persona as string));
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge'), { persona: 'favour rollback safety' }),
        voter(vote('merge'), { persona: 'favour rollback safety' }),
      ],
      events,
    });

    await council.decide(req());

    expect(new Set(personas).size).toBe(1);
  });

  it('accepts every built-in persona, including the three no surface offers', async () => {
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge'), { persona: 'security' }),
        voter(vote('merge'), { persona: 'maintainer' }),
        voter(vote('merge'), { persona: 'user-advocate' }),
      ],
    });

    const decision = await council.decide(req());
    expect(decision.type).toBe('answer');
  });
});

describe('createCouncilBrainArbiter — timeout budget', () => {
  it('convenes when the per-seat timeout exceeds the 90s default overall budget', async () => {
    // Regression for the council config bomb: the dynamic profile never set
    // overallTimeoutMs, so a `brain.council.perCallTimeoutMs` or
    // `brain.decisionTimeoutMs` above the 90_000ms default made
    // normalizeCouncilProfile throw on every ask(). The tiered arbiter
    // swallowed the throw, so the council silently degraded to the
    // single-LLM tier while every surface still reported it as convened.
    const council = createCouncilBrainArbiter({
      voters: [
        voter(vote('merge'), { persona: 'executor' }),
        voter(vote('merge'), { persona: 'auditor' }),
        voter(vote('hold'), { persona: 'skeptic' }),
      ],
      decisionTimeoutMs: 120_000,
    });
    const d = await council.decide(req());
    expect(d).toMatchObject({ type: 'answer', optionId: 'merge' });
  });

  it('forwards the orchestrator signal to a seat call so an abort interrupts it', async () => {
    // Direct test of the exact production caller factory: if makeSeatCallerForVoter
    // ever drops `input.signal` again, the provider receives no external signal,
    // hangs until its 30s per-call timeout, and this test fails on its 3s timeout.
    const controller = new AbortController();
    const provider = abortSensitiveProvider();
    const caller = makeSeatCallerForVoter({ provider, model: 'm' });

    const pending = caller.call({
      system: 's',
      userPrompt: 'u',
      timeoutMs: 30_000,
      maxTokens: 200,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(provider.complete).toHaveBeenCalled());
    controller.abort();
    const result = await pending;
    // The seat caller captures the abort as an error result instead of throwing.
    expect(result.error).toContain('aborted');
  }, 3_000);
});

describe('makeSeatCallerForVoter — wire fidelity', () => {
  it('forwards the requested responseFormat to the provider call', async () => {
    // The orchestrator asks every seat/judge call for json_object. Dropping
    // it here left JSON emission to prompt persuasion — which reasoning
    // models routinely ignore, producing `invalid` votes.
    const provider = fakeProvider(vote('merge'));
    const caller = makeSeatCallerForVoter({ provider, model: 'm' });
    await caller.call({
      system: 's',
      userPrompt: 'u',
      timeoutMs: 5_000,
      maxTokens: 200,
      responseFormat: { type: 'json_object' },
    });
    const request = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      responseFormat?: unknown;
    };
    expect(request.responseFormat).toEqual({ type: 'json_object' });
  });

  it('carries the provider stopReason into the seat result', async () => {
    // Without this the orchestrator cannot tell "returned garbage" apart
    // from "cut off at maxTokens", and every truncation surfaced as a bare
    // "did not contain JSON".
    const provider = {
      id: 'fake',
      capabilities: {},
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: [{ type: 'text', text: '{"optionId":' }],
        stopReason: 'max_tokens',
      })),
    } as never as Provider;
    const caller = makeSeatCallerForVoter({ provider, model: 'm' });
    const result = await caller.call({
      system: 's',
      userPrompt: 'u',
      timeoutMs: 5_000,
      maxTokens: 10,
    });
    expect(result.stopReason).toBe('max_tokens');
  });
});

describe('createCouncilBrainArbiter — voter output budget', () => {
  it('defaults voterMaxTokens to 2000 instead of the orchestrator 300', async () => {
    // Brain panels are routinely built from reasoning models whose thinking
    // tokens count against maxTokens; 300 starved them into `invalid` votes.
    const provider = fakeProvider(vote('merge'));
    const council = createCouncilBrainArbiter({
      voters: [
        { provider, model: 'm', persona: 'executor' },
        voter(vote('merge'), { persona: 'auditor' }),
      ],
    });
    await council.decide(req());
    const request = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      maxTokens?: number;
    };
    expect(request.maxTokens).toBe(2000);
  });

  it('honours an explicit voterMaxTokens override', async () => {
    const provider = fakeProvider(vote('merge'));
    const council = createCouncilBrainArbiter({
      voters: [
        { provider, model: 'm', persona: 'executor' },
        voter(vote('merge'), { persona: 'auditor' }),
      ],
      voterMaxTokens: 4321,
    });
    await council.decide(req());
    const request = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      maxTokens?: number;
    };
    expect(request.maxTokens).toBe(4321);
  });
});

describe('completeBrainLlmDetailed — abort signal composition', () => {
  it('fails fast when the external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = abortSensitiveProvider();

    await expect(
      completeBrainLlmDetailed(
        { provider, model: 'm' },
        { system: 's', user: 'u', timeoutMs: 30_000, signal: controller.signal },
      ),
    ).rejects.toThrow('aborted');
    // The provider is never reached — no waiting out the per-call timeout.
    expect(provider.complete).not.toHaveBeenCalled();
  }, 3_000);

  it('interrupts an in-flight call when the external signal aborts mid-call', async () => {
    const controller = new AbortController();
    const provider = abortSensitiveProvider();

    const pending = completeBrainLlmDetailed(
      { provider, model: 'm' },
      { system: 's', user: 'u', timeoutMs: 30_000, signal: controller.signal },
    );
    // Wait for the call to be in flight, then abort. Before the fix the
    // external signal was ignored and the call would have hung until its
    // 30s per-call timeout (failing this test on its own timeout).
    await vi.waitFor(() => expect(provider.complete).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  }, 3_000);

  it('aborts the provider call when the per-call timeout expires', async () => {
    const provider = abortSensitiveProvider();
    await expect(
      completeBrainLlmDetailed({ provider, model: 'm' }, { system: 's', user: 'u', timeoutMs: 20 }),
    ).rejects.toThrow('aborted');
  }, 2_000);

  it('completes normally when no external signal aborts', async () => {
    const provider = fakeProvider('done');
    const result = await completeBrainLlmDetailed(
      { provider, model: 'm' },
      { system: 's', user: 'u', timeoutMs: 30_000 },
    );
    expect(result.text).toBe('done');
  });
});

describe('completeBrainLlm — signal forwarding', () => {
  it('forwards the external signal to the underlying detailed call', async () => {
    const controller = new AbortController();
    const provider = abortSensitiveProvider();

    const pending = completeBrainLlm(
      { provider, model: 'm' },
      { system: 's', user: 'u', timeoutMs: 30_000, signal: controller.signal },
    );
    await vi.waitFor(() => expect(provider.complete).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  }, 3_000);
});

describe('council control-plane discipline', () => {
  it('abstains rather than answering with an option that was never offered', async () => {
    // Every Brain consumer acts on an EXACT optionId ("did it say `stop`?"),
    // so an `answer` carrying no optionId reads as "not stop" — the verdict
    // silently becomes its opposite.
    const arbiter = createCouncilBrainArbiter({
      voters: [
        {
          provider: fakeProvider('{"optionId":"launch_rockets","rationale":"go"}'),
          model: 'm1',
          persona: 'executor',
        },
        {
          provider: fakeProvider('{"optionId":"launch_rockets","rationale":"go"}'),
          model: 'm2',
          persona: 'skeptic',
        },
      ],
    });

    const d = await arbiter.decide({
      id: 'req-offmenu',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [
        { id: 'go', label: 'Go' },
        { id: 'stop', label: 'Stop' },
      ],
    });

    expect(d.type).not.toBe('answer');
  });

  it('still answers with the exact option id when the panel picks a real one', async () => {
    const arbiter = createCouncilBrainArbiter({
      voters: [
        {
          provider: fakeProvider('{"optionId":"go","rationale":"safe"}'),
          model: 'm1',
          persona: 'executor',
        },
        {
          provider: fakeProvider('{"optionId":"go","rationale":"fine"}'),
          model: 'm2',
          persona: 'skeptic',
        },
      ],
    });

    const d = await arbiter.decide({
      id: 'req-onmenu',
      source: 'director',
      question: 'Proceed?',
      risk: 'high',
      fallback: 'deny',
      options: [
        { id: 'go', label: 'Go' },
        { id: 'stop', label: 'Stop' },
      ],
    });

    expect(d).toMatchObject({ type: 'answer', optionId: 'go', text: 'Go' });
  });
});
