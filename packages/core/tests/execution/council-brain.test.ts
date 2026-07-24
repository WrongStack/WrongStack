import { describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';
import {
  COUNCIL_REFUSE_OPTION_ID,
  type CouncilVoter,
  createCouncilBrainArbiter,
} from '../../src/execution/council-brain.js';
import type { BrainLlmTarget } from '../../src/execution/autonomy-brain.js';
import type { Provider } from '../../src/types/provider.js';
import { EventBus } from '../../src/kernel/events.js';

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

const voter = (text: string, over: Partial<CouncilVoter> = {}): CouncilVoter => ({
  provider: fakeProvider(text),
  model: 'm',
  ...over,
});

const vote = (optionId: string, rationale = 'because') =>
  JSON.stringify({ optionId, rationale });

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
      voters: [
        voter(vote('hold'), { weight: 3 }),
        voter(vote('merge')),
        voter(vote('merge')),
      ],
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

  it('falls back to the first stance without a judge', async () => {
    const council = createCouncilBrainArbiter({
      voters: [voter('Continue, progress is real.'), voter('Stop now.')],
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
        { provider: fakeProvider('{"optionId":"go","rationale":"safe"}'), model: 'm1', persona: 'executor' },
        { provider: fakeProvider('{"optionId":"go","rationale":"fine"}'), model: 'm2', persona: 'skeptic', veto: true },
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

    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ requestId: 'req-trace', seatId: 'voter-0' });
    // Seat weight/veto come from the configured seats, not from the vote row.
    expect(votes[1]).toMatchObject({ seatId: 'voter-1', veto: true });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      requestId: 'req-trace',
      configuredSeatCount: 2,
      judgeUsed: false,
    });
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
