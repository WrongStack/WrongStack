// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  selectAutoProceedCandidate,
  useNextStepsAutoSubmit,
} from '../src/hooks/use-next-steps-auto-submit.js';
import { createTestState } from './helpers/create-test-state.js';

describe('selectAutoProceedCandidate', () => {
  it('makes the live todo authoritative over stale suggestions', () => {
    const candidate = selectAutoProceedCandidate({
      todos: [{ id: 'fix', content: 'Finish the todo lifecycle fix', status: 'in_progress' }],
      suggestions: ['Repeat an obsolete next step'],
      autoSuggestions: ['Repeat an obsolete automatic step'],
      yolo: true,
      autonomyNextPrompt: 'AUTO: {{suggestion}}',
    });

    expect(candidate?.source).toBe('todo');
    expect(candidate?.todoId).toBe('fix');
    expect(candidate?.prompt).toContain('Finish the todo lifecycle fix');
    expect(candidate?.prompt).not.toContain('obsolete');
  });

  it('uses a suggestion only after every todo is completed', () => {
    const candidate = selectAutoProceedCandidate({
      todos: [{ id: 'done', content: 'Finished work', status: 'completed' }],
      suggestions: ['Run the release check'],
    });

    expect(candidate).toMatchObject({
      source: 'suggestion',
      prompt: 'Run the release check',
    });
  });
});

describe('useNextStepsAutoSubmit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays parked while a resumed session holds auto-proceed', async () => {
    // The bug this pins: `/resume` restores the session's todo board, and an
    // open todo is grounded work as far as `selectAutoProceedCandidate` is
    // concerned — so resuming a session with unfinished todos started a turn
    // on a countdown the user never armed. A resume must land waiting.
    const todos = [
      { id: 'fix', content: 'Close the finished todo', status: 'in_progress' as const },
    ];
    const runBlocks = vi.fn(async () => undefined);
    const options = (autoProceedHold: boolean): Parameters<typeof useNextStepsAutoSubmit>[0] => ({
      state: createTestState({ status: 'idle', autoProceedHold }),
      autonomyLive: 'auto',
      agent: { ctx: { todos } } as never,
      getAutonomy: () => 'auto',
      getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 0 }) as never,
      getSuggestions: () => [],
      getAutoSuggestions: () => [],
      getYolo: () => false,
      setSuggestions: vi.fn(),
      autonomyNextPrompt: undefined,
      dispatch: vi.fn(),
      clearDraft: vi.fn(),
      runBlocksRef: { current: runBlocks },
    });

    const { rerender, result } = renderHook(
      ({ hold }: { hold: boolean }) => useNextStepsAutoSubmit(options(hold)),
      { initialProps: { hold: true } },
    );

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(runBlocks).not.toHaveBeenCalled();
    // No countdown is shown either — a visible timer that will never fire is
    // worse than none.
    expect(result.current.nextStepsAutoSubmitCountdown).toBeNull();

    // Releasing the hold (what the manual submit path dispatches) re-arms the
    // same board without touching autonomy, which stayed 'auto' throughout.
    rerender({ hold: false });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(runBlocks).toHaveBeenCalled();
  });

  it('does not persist a todo continuation as a reusable suggestion', async () => {
    const todos = [
      { id: 'fix', content: 'Close the finished todo', status: 'in_progress' as const },
    ];
    const suggestionStore = ['stale next step'];
    const setSuggestions = vi.fn((next: string[]) => {
      suggestionStore.splice(0, suggestionStore.length, ...next);
    });
    const runBlocks = vi.fn(async () => undefined);

    renderHook(() =>
      useNextStepsAutoSubmit({
        state: createTestState({ status: 'idle' }),
        autonomyLive: 'auto',
        agent: { ctx: { todos } } as never,
        getAutonomy: () => 'auto',
        getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 50 }) as never,
        getSuggestions: () => [...suggestionStore],
        getAutoSuggestions: () => [],
        getYolo: () => false,
        setSuggestions,
        autonomyNextPrompt: undefined,
        dispatch: vi.fn(),
        clearDraft: vi.fn(),
        runBlocksRef: { current: runBlocks },
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(setSuggestions).toHaveBeenCalledWith([]);
    expect(setSuggestions).not.toHaveBeenCalledWith([
      expect.stringContaining('Close the finished todo'),
    ]);
    const blocks = (
      runBlocks.mock.calls as unknown as Array<Array<Array<{ text?: string }>>>
    )[0]?.[0] as Array<{ text?: string }> | undefined;
    expect(blocks?.[0]?.text).toContain('Close the finished todo');
    expect(blocks?.[0]?.text).not.toContain('stale next step');
  });

  it('marks a pending grounded todo running through ConversationState before submitting it', async () => {
    const todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
    }> = [
      { id: 'next', content: 'Implement the lifecycle fix', status: 'pending' },
      { id: 'later', content: 'Run broad validation', status: 'pending' },
    ];
    const replaceTodos = vi.fn((next: typeof todos) => {
      todos.splice(0, todos.length, ...next);
    });
    const runBlocks = vi.fn(async () => undefined);

    renderHook(() =>
      useNextStepsAutoSubmit({
        state: createTestState({ status: 'idle' }),
        autonomyLive: 'auto',
        agent: { ctx: { todos, state: { replaceTodos } } } as never,
        getAutonomy: () => 'auto',
        getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 50 }) as never,
        getSuggestions: () => [],
        getAutoSuggestions: () => [],
        getYolo: () => false,
        setSuggestions: vi.fn(),
        autonomyNextPrompt: undefined,
        dispatch: vi.fn(),
        clearDraft: vi.fn(),
        runBlocksRef: { current: runBlocks },
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(replaceTodos).toHaveBeenCalledTimes(1);
    expect(todos.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'next', status: 'in_progress' },
      { id: 'later', status: 'pending' },
    ]);
    expect(runBlocks).toHaveBeenCalledTimes(1);
  });

  // ── Advancement path ─────────────────────────────────────────────────
  // When a grounded (todo-sourced) prompt stalls — the board hasn't moved
  // across three consecutive automatic turns (feed → steer → halt) — instead
  // of stopping the auto-proceed loop, the hook generates an advancement
  // prompt for the next open todo. This keeps the agent working when there
  // is still unfinished work. Only when no more open todos remain does it
  // halt with a warning. See auto-proceed-loop-guard.ts for the shared logic
  // and use-next-steps-auto-submit.ts lines 296–381 for the hook integration.

  it('advances to the next open todo when a grounded prompt stalls (feed→steer→halt→advance)', async () => {
    // Two open todos. The in-progress one will stall; the pending one is the
    // advancement target.
    const todos = [
      { id: 't1', content: 'Fix the login bug', status: 'in_progress' as const },
      { id: 't2', content: 'Write unit tests for parser', status: 'pending' as const },
    ];
    const runBlocks = vi.fn(async (_blocks: Array<{ type: string; text?: string }>) => undefined);
    const dispatch = vi.fn();

    // The hook re-reads state on every render. Toggling status between
    // 'idle' and 'running' forces the effect to clean up and re-run,
    // simulating distinct agent turns.
    let currentStatus: 'idle' | 'running' = 'idle';
    const { rerender } = renderHook(() =>
      useNextStepsAutoSubmit({
        state: createTestState({ status: currentStatus }),
        autonomyLive: 'auto',
        agent: { ctx: { todos } } as never,
        getAutonomy: () => 'auto',
        getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 50 }) as never,
        getSuggestions: () => [],
        getAutoSuggestions: () => [],
        getYolo: () => false,
        setSuggestions: vi.fn(),
        autonomyNextPrompt: undefined,
        dispatch,
        clearDraft: vi.fn(),
        runBlocksRef: { current: runBlocks },
      }),
    );

    // ── Cycle 1: first feed (runLength=1, action=feed) ──
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(runBlocks).toHaveBeenCalledTimes(1);
    const cycle1Text =
      (runBlocks.mock.calls[0]?.[0] as Array<{ text: string }> | undefined)?.[0]?.text ?? '';
    expect(cycle1Text).toContain('Fix the login bug');
    // Normal continuation prompt, not an advancement prompt.
    expect(cycle1Text).toContain('Continue with the plan');

    // Simulate agent turn: idle → running → idle
    await act(async () => {
      currentStatus = 'running';
      rerender();
    });
    await act(async () => {
      currentStatus = 'idle';
      rerender();
    });

    // ── Cycle 2: second feed (runLength=2, action=steer) ──
    // Same prompt + steer text appended. Board hasn't moved.
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(runBlocks).toHaveBeenCalledTimes(2);
    const cycle2Text =
      (runBlocks.mock.calls[1]?.[0] as Array<{ text: string }> | undefined)?.[0]?.text ?? '';
    expect(cycle2Text).toContain('Fix the login bug');
    // Steer text is appended on the first repetition.
    expect(cycle2Text).toContain('todo board has not changed');

    await act(async () => {
      currentStatus = 'running';
      rerender();
    });
    await act(async () => {
      currentStatus = 'idle';
      rerender();
    });

    // ── Cycle 3: halt → advancement to next todo ──
    // Board still frozen. Guard returns action=halt. Instead of halting, the
    // hook advances to t2 with a varied advancement prompt.
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(runBlocks).toHaveBeenCalledTimes(3);
    const cycle3Text =
      (runBlocks.mock.calls[2]?.[0] as Array<{ text: string }> | undefined)?.[0]?.text ?? '';
    // The advancement prompt targets the NEXT open todo.
    expect(cycle3Text).toContain('Write unit tests for parser');
    // It is NOT the original stalled continuation prompt.
    expect(cycle3Text).not.toContain('Continue with the plan');
    // It includes board context and an attempt reference.
    expect(cycle3Text).toContain('Todo board');
    expect(cycle3Text).toMatch(/attempt|try/i);

    // No halt warning was dispatched — the loop kept going.
    const warnCalls = dispatch.mock.calls.filter(
      ([action]) =>
        (action as { type: string }).type === 'addEntry' &&
        (action as { entry: { kind: string } }).entry?.kind === 'warn',
    );
    expect(warnCalls).toHaveLength(0);
  });

  it('halts with "No more open todos" when the only open todo stalls', async () => {
    // Single todo — no next item to advance to.
    const todos = [
      { id: 'solo', content: 'Only open task on the board', status: 'in_progress' as const },
    ];
    const runBlocks = vi.fn(async (_blocks: Array<{ type: string; text?: string }>) => undefined);
    const dispatch = vi.fn();

    let currentStatus: 'idle' | 'running' = 'idle';
    const { rerender } = renderHook(() =>
      useNextStepsAutoSubmit({
        state: createTestState({ status: currentStatus }),
        autonomyLive: 'auto',
        agent: { ctx: { todos } } as never,
        getAutonomy: () => 'auto',
        getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 50 }) as never,
        getSuggestions: () => [],
        getAutoSuggestions: () => [],
        getYolo: () => false,
        setSuggestions: vi.fn(),
        autonomyNextPrompt: undefined,
        dispatch,
        clearDraft: vi.fn(),
        runBlocksRef: { current: runBlocks },
      }),
    );

    // Cycle 1: feed
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    await act(async () => {
      currentStatus = 'running';
      rerender();
    });
    await act(async () => {
      currentStatus = 'idle';
      rerender();
    });

    // Cycle 2: steer
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    await act(async () => {
      currentStatus = 'running';
      rerender();
    });
    await act(async () => {
      currentStatus = 'idle';
      rerender();
    });

    // Cycle 3: halt — no next todo to advance to
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // Only 2 runBlocks calls (feed + steer); the 3rd cycle halts instead.
    expect(runBlocks).toHaveBeenCalledTimes(2);

    // A warning entry was dispatched about no more open todos.
    const warnEntries = dispatch.mock.calls
      .map(([action]) => action as { type: string; entry?: { kind: string; text: string } })
      .filter((action) => action.type === 'addEntry' && action.entry?.kind === 'warn');
    expect(warnEntries.length).toBeGreaterThan(0);
    expect(warnEntries[warnEntries.length - 1]!.entry!.text).toContain('No more open todos');
  });

  it('halts after MAX_ADVANCEMENT_ATTEMPTS total advancement cycles are exhausted', async () => {
    // Many todos so advancement can cycle through them. Each cycle needs 3
    // feeds (feed→steer→halt). After enough cycles, total advancements exceed
    // MAX_ADVANCEMENT_ATTEMPTS (9) and the hook must halt.
    const todos = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i + 1}`,
      content: `Task number ${i + 1}`,
      status: (i === 0 ? 'in_progress' : 'pending') as 'in_progress' | 'pending',
    }));
    const runBlocks = vi.fn(async (_blocks: Array<{ type: string; text?: string }>) => undefined);
    const dispatch = vi.fn();

    let currentStatus: 'idle' | 'running' = 'idle';
    const { rerender } = renderHook(() =>
      useNextStepsAutoSubmit({
        state: createTestState({ status: currentStatus }),
        autonomyLive: 'auto',
        agent: { ctx: { todos } } as never,
        getAutonomy: () => 'auto',
        getSettings: () => ({ delayMs: 0, autoProceedMaxIterations: 50 }) as never,
        getSuggestions: () => [],
        getAutoSuggestions: () => [],
        getYolo: () => false,
        setSuggestions: vi.fn(),
        autonomyNextPrompt: undefined,
        dispatch,
        clearDraft: vi.fn(),
        runBlocksRef: { current: runBlocks },
      }),
    );

    // Simulate turns. Each advancement needs 3 feeds (feed→steer→halt) then
    // the advancement fires as the 3rd feed. We cap at enough cycles to blow
    // past MAX_ADVANCEMENT_ATTEMPTS=9 (so ~10 advancements × 3 feeds = ~30
    // cycles). After the cap, the hook must dispatch a halt warning.
    //
    // We use a generous ceiling and break early as soon as a warn appears.
    let halted = false;
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });

      const warnEntries = dispatch.mock.calls
        .map(([action]) => action as { type: string; entry?: { kind: string; text: string } })
        .filter((action) => action.type === 'addEntry' && action.entry?.kind === 'warn');
      if (warnEntries.length > 0) {
        halted = true;
        break;
      }

      await act(async () => {
        currentStatus = 'running';
        rerender();
      });
      await act(async () => {
        currentStatus = 'idle';
        rerender();
      });
    }

    expect(halted).toBe(true);
    const warnEntries = dispatch.mock.calls
      .map(([action]) => action as { type: string; entry?: { kind: string; text: string } })
      .filter((action) => action.type === 'addEntry' && action.entry?.kind === 'warn');
    expect(warnEntries.length).toBeGreaterThan(0);
    // The halt message is either the advancement-cap or the no-todos message.
    const lastWarn = warnEntries[warnEntries.length - 1]!.entry!.text;
    expect(lastWarn.includes('No more open todos') || lastWarn.includes('Auto-submit halted')).toBe(
      true,
    );
  });
});
