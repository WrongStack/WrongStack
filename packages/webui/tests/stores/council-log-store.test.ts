import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CouncilPanelEntry,
  isCouncilPanelAdverse,
  MAX_COUNCIL_PANELS,
  summarizeCouncilPanel,
  toCouncilSeatVote,
  useCouncilLogStore,
} from '../../src/stores/council-log-store';

function vote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    seatId: 'voter-0',
    persona: 'executor',
    status: 'valid',
    optionId: 'merge',
    model: 'gpt-5',
    at: 1000,
    ...over,
  };
}

function resolution(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    status: 'decided',
    resolution: 'majority',
    optionId: 'merge',
    configuredSeatCount: 3,
    validVoteCount: 3,
    distinctTargetCount: 3,
    judgeUsed: false,
    usage: { totalTokens: 420, durationMs: 1250 },
    at: 2000,
    ...over,
  };
}

const panel = (): CouncilPanelEntry => useCouncilLogStore.getState().panels[0] as CouncilPanelEntry;

beforeEach(() => {
  useCouncilLogStore.getState().clear();
});

describe('recordVote', () => {
  it('opens a panel on the first seat so a running council is visible before it resolves', () => {
    // The whole point of the tab: a council is N provider calls and up to ~90s.
    // Waiting for the resolution to show anything would leave the most
    // expensive tier looking like a stalled request.
    useCouncilLogStore.getState().recordVote(vote());

    expect(panel().phase).toBe('voting');
    expect(panel().requestId).toBe('req-1');
    expect(panel().seats).toHaveLength(1);
  });

  it('accumulates seats of the same request into one panel', () => {
    useCouncilLogStore.getState().recordVote(vote());
    useCouncilLogStore.getState().recordVote(vote({ seatId: 'voter-1', persona: 'skeptic' }));

    expect(useCouncilLogStore.getState().panels).toHaveLength(1);
    expect(panel().seats.map((s) => s.persona)).toEqual(['executor', 'skeptic']);
  });

  it('replaces rather than duplicates a re-delivered seat vote', () => {
    // A reconnect can replay events; the seat id is the identity, not arrival
    // order, so a replay must not inflate the seat count.
    useCouncilLogStore.getState().recordVote(vote({ optionId: 'merge' }));
    useCouncilLogStore.getState().recordVote(vote({ optionId: 'hold' }));

    expect(panel().seats).toHaveLength(1);
    expect(panel().seats[0]?.optionId).toBe('hold');
  });

  it('keeps separate requests as separate panels, newest first', () => {
    useCouncilLogStore.getState().recordVote(vote({ requestId: 'req-1' }));
    useCouncilLogStore.getState().recordVote(vote({ requestId: 'req-2' }));

    expect(useCouncilLogStore.getState().panels.map((p) => p.requestId)).toEqual([
      'req-2',
      'req-1',
    ]);
  });

  it('ignores a vote with no request id rather than opening an anonymous panel', () => {
    useCouncilLogStore.getState().recordVote(vote({ requestId: undefined }));

    expect(useCouncilLogStore.getState().panels).toHaveLength(0);
  });

  it('bounds the buffer — a council that never resolves must not leak', () => {
    for (let i = 0; i < MAX_COUNCIL_PANELS + 10; i += 1) {
      useCouncilLogStore.getState().recordVote(vote({ requestId: `req-${i}` }));
    }

    expect(useCouncilLogStore.getState().panels).toHaveLength(MAX_COUNCIL_PANELS);
    // Newest survives, oldest is evicted.
    expect(panel().requestId).toBe(`req-${MAX_COUNCIL_PANELS + 9}`);
  });

  it('produces a new array so subscribers re-render', () => {
    useCouncilLogStore.getState().recordVote(vote());
    const first = useCouncilLogStore.getState().panels;
    useCouncilLogStore.getState().recordVote(vote({ seatId: 'voter-1' }));

    expect(useCouncilLogStore.getState().panels).not.toBe(first);
  });
});

describe('recordResolution', () => {
  it('flips the panel to resolved and records the tally', () => {
    useCouncilLogStore.getState().recordVote(vote());
    useCouncilLogStore.getState().recordResolution(resolution());

    expect(panel()).toMatchObject({
      phase: 'resolved',
      resolution: 'majority',
      status: 'decided',
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 3,
      totalTokens: 420,
      durationMs: 1250,
      resolvedAt: 2000,
    });
  });

  it('keeps the seat votes gathered before the resolution', () => {
    useCouncilLogStore.getState().recordVote(vote());
    useCouncilLogStore.getState().recordVote(vote({ seatId: 'voter-1', persona: 'skeptic' }));
    useCouncilLogStore.getState().recordResolution(resolution());

    expect(panel().seats).toHaveLength(2);
  });

  it('opens a panel even when no seat vote arrived first', () => {
    // Every seat can fail before emitting a usable vote; the resolution still
    // carries the counts, and dropping it would hide the failure entirely.
    useCouncilLogStore
      .getState()
      .recordResolution(resolution({ status: 'abstained', validVoteCount: 0 }));

    expect(panel().phase).toBe('resolved');
    expect(panel().seats).toHaveLength(0);
  });

  it('retains the distinctness warnings that flag a correlated panel', () => {
    useCouncilLogStore
      .getState()
      .recordResolution(
        resolution({ warnings: ['Council distinctness policy "model" was not met.', 42] }),
      );

    expect(panel().warnings).toEqual(['Council distinctness policy "model" was not met.']);
  });
});

describe('noteQuestion', () => {
  it('folds the question into an open panel', () => {
    useCouncilLogStore.getState().recordVote(vote());
    useCouncilLogStore.getState().noteQuestion('req-1', 'Merge the risky auth change?');

    expect(panel().question).toBe('Merge the risky auth change?');
  });

  it('does NOT create a panel for a request that never convened a council', () => {
    // Every Brain decision emits decision_* events, including the free policy
    // and single-LLM tiers. Creating a row here would fill the log with empty
    // panels that no council ever ran.
    useCouncilLogStore.getState().noteQuestion('req-policy', 'Retry the failed tool?');

    expect(useCouncilLogStore.getState().panels).toHaveLength(0);
  });

  it('ignores blank text and leaves the state object identical', () => {
    useCouncilLogStore.getState().recordVote(vote());
    const before = useCouncilLogStore.getState().panels;
    useCouncilLogStore.getState().noteQuestion('req-1', '   ');

    expect(useCouncilLogStore.getState().panels).toBe(before);
  });

  it('is a no-op when the question is already recorded', () => {
    useCouncilLogStore.getState().recordVote(vote());
    useCouncilLogStore.getState().noteQuestion('req-1', 'Same question');
    const after = useCouncilLogStore.getState().panels;
    useCouncilLogStore.getState().noteQuestion('req-1', 'Same question');

    expect(useCouncilLogStore.getState().panels).toBe(after);
  });
});

describe('toCouncilSeatVote', () => {
  it('carries the observable vote through', () => {
    expect(toCouncilSeatVote(vote({ veto: true, durationMs: 12 }), 999)).toEqual({
      seatId: 'voter-0',
      persona: 'executor',
      status: 'valid',
      optionId: 'merge',
      stance: undefined,
      rationale: undefined,
      providerId: undefined,
      model: 'gpt-5',
      veto: true,
      weight: undefined,
      durationMs: 12,
      error: undefined,
      at: 1000,
    });
  });

  it('falls back for a payload missing identity fields', () => {
    const seat = toCouncilSeatVote({}, 777);

    expect(seat).toMatchObject({ seatId: 'seat', persona: 'voter', status: 'valid', at: 777 });
  });
});

describe('summarizeCouncilPanel', () => {
  it('reports seat progress while the panel is still voting', () => {
    useCouncilLogStore.getState().recordVote(vote());

    expect(summarizeCouncilPanel(panel())).toBe('voting · 1 seat in');
  });

  it('puts panel diversity on the headline next to the seat count', () => {
    // A panel whose seats all resolved to the same model produces a normal
    // unanimous verdict while adding cost without adding independence.
    useCouncilLogStore
      .getState()
      .recordResolution(resolution({ distinctTargetCount: 1, judgeUsed: true }));

    expect(summarizeCouncilPanel(panel())).toBe(
      'majority · 3/3 seats · 1 distinct target · judge · 1.3s · 420 tok',
    );
  });

  it('omits cost fields the resolution did not carry', () => {
    useCouncilLogStore.getState().recordResolution(resolution({ usage: undefined }));

    expect(summarizeCouncilPanel(panel())).toBe('majority · 3/3 seats · 3 distinct targets');
  });
});

describe('isCouncilPanelAdverse', () => {
  it('is false while voting and for a clean decision', () => {
    useCouncilLogStore.getState().recordVote(vote());
    expect(isCouncilPanelAdverse(panel())).toBe(false);

    useCouncilLogStore.getState().recordResolution(resolution());
    expect(isCouncilPanelAdverse(panel())).toBe(false);
  });

  it('is true for a denial, a non-verdict, or a warned panel', () => {
    for (const over of [
      { status: 'denied' },
      { status: 'abstained' },
      { status: 'failed' },
      { status: 'cancelled' },
      { warnings: ['not diverse'] },
    ]) {
      useCouncilLogStore.getState().clear();
      useCouncilLogStore.getState().recordResolution(resolution(over));
      expect(isCouncilPanelAdverse(panel())).toBe(true);
    }
  });
});

describe('deliberation rendering', () => {
  it('keeps one row per seat across rounds and shows the round while voting', () => {
    const store = useCouncilLogStore.for('s1');
    store.getState().recordVote({ requestId: 'r1', seatId: 'a', persona: 'executor', round: 1 });
    store.getState().recordVote({ requestId: 'r1', seatId: 'b', persona: 'skeptic', round: 1 });
    store
      .getState()
      .recordVote({ requestId: 'r1', seatId: 'a', persona: 'executor', round: 2, changed: true });

    const panel = store.getState().panels[0]!;
    // A deliberating panel re-polls every seat; appending would list each
    // seat once per round.
    expect(panel.seats).toHaveLength(2);
    expect(panel.seats.find((seat) => seat.seatId === 'a')?.changed).toBe(true);
    expect(summarizeCouncilPanel(panel)).toContain('r2');
  });

  it('reports the round count and how many seats moved', () => {
    const store = useCouncilLogStore.for('s2');
    store.getState().recordVote({ requestId: 'r1', seatId: 'a', persona: 'executor' });
    store.getState().recordResolution({
      requestId: 'r1',
      status: 'decided',
      resolution: 'majority',
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 3,
      rounds: 2,
      deliberationChanges: 2,
    });

    expect(summarizeCouncilPanel(store.getState().panels[0]!)).toContain('2 rounds, 2 changed');
  });

  it('says so when the extra rounds changed nothing', () => {
    const store = useCouncilLogStore.for('s3');
    store.getState().recordVote({ requestId: 'r1', seatId: 'a', persona: 'executor' });
    store.getState().recordResolution({
      requestId: 'r1',
      status: 'decided',
      resolution: 'majority',
      rounds: 2,
      deliberationChanges: 0,
    });

    // 0 is the honest signal that deliberation bought cost and nothing else.
    expect(summarizeCouncilPanel(store.getState().panels[0]!)).toContain('none changed');
  });

  it('treats a judge that had already voted as an adverse panel', () => {
    const store = useCouncilLogStore.for('s4');
    store.getState().recordVote({ requestId: 'r1', seatId: 'a', persona: 'executor' });
    store.getState().recordResolution({
      requestId: 'r1',
      status: 'decided',
      resolution: 'judge',
      judgeUsed: true,
      judgeLabel: 'p/m1',
      judgeIsVoter: true,
    });

    const panel = store.getState().panels[0]!;
    // A tie-breaker that cast one of the tied votes is a panel-integrity
    // problem, exactly like a correlated panel.
    expect(isCouncilPanelAdverse(panel)).toBe(true);
    expect(summarizeCouncilPanel(panel)).toContain('judge p/m1 (also a voter)');
  });
});
