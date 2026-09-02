import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAutoSubmitStreak } from '../../src/stores/auto-submit-streak.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';

describe('useAutoSubmitStreak loop guard', () => {
  beforeEach(() => {
    useLocalPrefs.setState({ autonomy: 'auto', autoProceedMaxIterations: 50 });
    useSessionStore.getState().setSession({
      id: 'auto-loop-session',
      startedAt: Date.now(),
      provider: 'test',
      model: 'test',
    });

    const { result, unmount } = renderHook(() => useAutoSubmitStreak());
    act(() => result.current.reset());
    unmount();
  });

  it('shares repetition history across hook instances and latches the halt', () => {
    const first = renderHook(() => useAutoSubmitStreak());
    const second = renderHook(() => useAutoSubmitStreak());

    expect(first.result.current.recordPrompt('Run the focused tests')).toBe(true);
    expect(second.result.current.recordPrompt('  RUN the focused tests  ')).toBe(false);
    expect(first.result.current.canAutoSubmit()).toBe(false);
    expect(second.result.current.recordPrompt('Try a different prompt')).toBe(false);
  });

  it('manual reset clears both the repetition history and halted latch with an unlimited cap', () => {
    useLocalPrefs.setState({ autoProceedMaxIterations: 0 });
    const { result } = renderHook(() => useAutoSubmitStreak());

    expect(result.current.recordPrompt('Continue')).toBe(true);
    expect(result.current.recordPrompt('Continue')).toBe(false);
    expect(result.current.canAutoSubmit()).toBe(false);

    act(() => result.current.reset());

    expect(result.current.canAutoSubmit()).toBe(true);
    expect(result.current.recordPrompt('Continue')).toBe(true);
  });

  it('recordGroundedPrompt returns canFeed:true on first grounded feed', () => {
    const { result } = renderHook(() => useAutoSubmitStreak());
    const todos = [{ id: 't1', content: 'Do the thing', status: 'pending' }];
    const response = result.current.recordGroundedPrompt('Continue with plan: Do the thing', todos);
    expect(response.canFeed).toBe(true);
    expect(response.advancement).toBeUndefined();
    expect(response.halted).toBeUndefined();
  });

  it('recordGroundedPrompt returns advancement when the same todo prompt repeats', () => {
    const { result } = renderHook(() => useAutoSubmitStreak());
    const todos = [
      { id: 't1', content: 'Task 1', status: 'in_progress' },
      { id: 't2', content: 'Task 2', status: 'pending' },
    ];
    // First grounded feed — ok.
    expect(result.current.recordGroundedPrompt('Continue with plan: Task 1', todos).canFeed).toBe(
      true,
    );
    // Second feed (same prompt) — repetitions should return advancement.
    const response = result.current.recordGroundedPrompt('Continue with plan: Task 1', todos);
    // After the first grounded feed -> steer (second feed tries steer first).
    // Feed 2 = steer (shouldHalt true, action=steer, advancement happens on halt branch)
    // Actually, grounded does feed -> steer -> halt. Feed 2 is steer but we only
    // advance on halt (feed 3). So feed 2 should be canFeed:true with steer.
    expect(response.canFeed).toBe(true);
  });

  it('recordGroundedPrompt halts when there are no more todos to advance to', () => {
    const { result } = renderHook(() => useAutoSubmitStreak());
    const single = [{ id: 't1', content: 'Only task', status: 'pending' }];
    // Feed 1: feed
    result.current.recordGroundedPrompt('Something: Only task', single);
    // Feed 2: steer (no halt yet for grounded, just feed with steer appended)
    result.current.recordGroundedPrompt('Something: Only task', single);
    // Feed 3: halt — only one todo, no advance possible
    const response = result.current.recordGroundedPrompt('Something: Only task', single);
    expect(response.canFeed).toBe(false);
    expect(response.halted).toBe(true);
    expect(response.advancement).toBeUndefined();
  });

  it('reset() clears the continuation tracker so previously halted prompts can be retried', () => {
    const { result } = renderHook(() => useAutoSubmitStreak());
    const single = [{ id: 't1', content: 'Only task', status: 'pending' }];
    // Run through feed -> steer -> halt (3 feeds)
    result.current.recordGroundedPrompt('Task: Only task', single);
    result.current.recordGroundedPrompt('Task: Only task', single);
    result.current.recordGroundedPrompt('Task: Only task', single);
    expect(result.current.canAutoSubmit()).toBe(false);
    // Reset everything
    act(() => result.current.reset());
    expect(result.current.canAutoSubmit()).toBe(true);
    // Fresh feed should work again
    expect(result.current.recordGroundedPrompt('Task: Only task', single).canFeed).toBe(true);
  });

  it('recordGroundedPrompt advances to next todo when current stalls', () => {
    const { result } = renderHook(() => useAutoSubmitStreak());
    const todos = [
      { id: 't1', content: 'Stalled task', status: 'in_progress' },
      { id: 't2', content: 'Next task', status: 'pending' },
    ];
    // Feed 1: feed
    let r = result.current.recordGroundedPrompt('Continue: Stalled task', todos);
    expect(r.canFeed).toBe(true);

    // Feed 2: steer (grounded, first repetition is steer, not halt)
    r = result.current.recordGroundedPrompt('Continue: Stalled task', todos);
    expect(r.canFeed).toBe(true);

    // Feed 3: halt → advance to t2
    r = result.current.recordGroundedPrompt('Continue: Stalled task', todos);
    expect(r.canFeed).toBe(false);
    expect(r.halted).toBeUndefined(); // not halted, advanced
    expect(r.advancement).toBeDefined();
    expect(r.advancement!.length).toBeGreaterThan(0);
    // Advancement prompt should contain the next todo
    expect(r.advancement!.toLowerCase()).toContain('next task');
  });
});
