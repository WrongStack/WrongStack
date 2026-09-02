import { beforeEach, describe, expect, it } from 'vitest';
import { type GoalAssessResultStore, useGoalAssessStore } from '../../src/stores/goal-assess-store';

function result(overrides: Partial<GoalAssessResultStore> = {}): GoalAssessResultStore {
  return {
    realistic: true,
    durationClaimed: '2 weeks',
    explanation: 'Scope matches the timeline.',
    recommendedDuration: null,
    concerns: [],
    parseFailed: false,
    reqSeq: 1,
    ...overrides,
  };
}

describe('goal assess store', () => {
  beforeEach(() => {
    useGoalAssessStore.setState({ result: null, loading: false, currentSeq: 0 });
  });

  it('starts empty and idle', () => {
    const s = useGoalAssessStore.getState();
    expect(s.result).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.currentSeq).toBe(0);
  });

  it('nextSeq increments monotonically and returns the new value', () => {
    const { nextSeq } = useGoalAssessStore.getState();
    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);
    expect(nextSeq()).toBe(3);
    expect(useGoalAssessStore.getState().currentSeq).toBe(3);
  });

  it('setLoading marks the request in-flight and drops any stale result', () => {
    useGoalAssessStore.setState({ result: result(), currentSeq: 1 });
    useGoalAssessStore.getState().setLoading();
    const s = useGoalAssessStore.getState();
    expect(s.loading).toBe(true);
    expect(s.result).toBeNull();
  });

  it('accepts a result whose reqSeq matches the current request', () => {
    useGoalAssessStore.getState().nextSeq();
    useGoalAssessStore.getState().setLoading();
    useGoalAssessStore.getState().setResult(result({ reqSeq: 1 }));
    const s = useGoalAssessStore.getState();
    expect(s.result?.reqSeq).toBe(1);
    expect(s.loading).toBe(false);
  });

  it('drops a stale result from a superseded request', () => {
    useGoalAssessStore.getState().nextSeq(); // seq 1
    useGoalAssessStore.getState().nextSeq(); // seq 2 — the live request
    useGoalAssessStore.getState().setLoading();

    // Round 1 replies late, after round 2 was issued.
    useGoalAssessStore.getState().setResult(result({ reqSeq: 1, explanation: 'stale' }));
    expect(useGoalAssessStore.getState().result).toBeNull();
    // Still loading — the live request has not answered yet.
    expect(useGoalAssessStore.getState().loading).toBe(true);

    useGoalAssessStore.getState().setResult(result({ reqSeq: 2, explanation: 'fresh' }));
    expect(useGoalAssessStore.getState().result?.explanation).toBe('fresh');
    expect(useGoalAssessStore.getState().loading).toBe(false);
  });

  it('drops a result arriving ahead of its request (reqSeq greater than currentSeq)', () => {
    useGoalAssessStore.getState().setResult(result({ reqSeq: 9 }));
    expect(useGoalAssessStore.getState().result).toBeNull();
  });

  it('stores unrealistic assessments with concerns and a recommendation', () => {
    useGoalAssessStore.getState().nextSeq();
    useGoalAssessStore.getState().setResult(
      result({
        reqSeq: 1,
        realistic: false,
        recommendedDuration: '6 weeks',
        concerns: ['migration is underestimated', 'no rollback plan'],
      }),
    );
    const stored = useGoalAssessStore.getState().result;
    expect(stored?.realistic).toBe(false);
    expect(stored?.recommendedDuration).toBe('6 weeks');
    expect(stored?.concerns).toHaveLength(2);
  });

  it('stores parse failures verbatim so the UI can surface the parser error', () => {
    useGoalAssessStore.getState().nextSeq();
    useGoalAssessStore
      .getState()
      .setResult(result({ reqSeq: 1, parseFailed: true, parseError: 'not JSON' }));
    const stored = useGoalAssessStore.getState().result;
    expect(stored?.parseFailed).toBe(true);
    expect(stored?.parseError).toBe('not JSON');
  });

  it('clear resets the result and loading flag but keeps the seq counter', () => {
    useGoalAssessStore.getState().nextSeq();
    useGoalAssessStore.getState().setLoading();
    useGoalAssessStore.getState().setResult(result({ reqSeq: 1 }));

    useGoalAssessStore.getState().clear();
    const s = useGoalAssessStore.getState();
    expect(s.result).toBeNull();
    expect(s.loading).toBe(false);
    // Keeping the counter is what makes a reply to the cleared request stale.
    expect(s.currentSeq).toBe(1);
  });
});
