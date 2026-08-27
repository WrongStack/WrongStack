import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
  const state = {
    activeSessionId: 'session-a' as string | null,
    listeners: new Set<(message: unknown) => void>(),
    getPlan: vi.fn(),
    updatePlanItem: vi.fn(),
  };
  return {
    ...state,
    client: {
      getPlan: state.getPlan,
      updatePlanItem: state.updatePlanItem,
      on: (_type: string, listener: (message: unknown) => void) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    },
  };
});

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores', () => ({
  useActiveSessionId: () => testState.activeSessionId,
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => testState.client,
}));

const { PlanPanel } = await import('@/components/PlanPanel');

function emitPlan(sessionId: string, title: string): void {
  const message = {
    type: 'plan.updated',
    payload: {
      sessionId,
      plan: { items: [{ id: `${sessionId}-1`, title, status: 'open' }] },
    },
  };
  for (const listener of testState.listeners) listener(message);
}

describe('PlanPanel session isolation', () => {
  beforeEach(() => {
    testState.activeSessionId = 'session-a';
    testState.listeners.clear();
    testState.getPlan.mockReset();
    testState.updatePlanItem.mockReset();
  });

  afterEach(() => cleanup());

  it('clears on a tab switch and ignores a late PLAN response from the previous session', () => {
    const view = render(<PlanPanel />);
    act(() => emitPlan('session-a', 'Plan A'));
    expect(screen.getByText('Plan A')).toBeTruthy();

    testState.activeSessionId = 'session-b';
    view.rerender(<PlanPanel />);
    expect(screen.queryByText('Plan A')).toBeNull();

    act(() => emitPlan('session-a', 'Late Plan A'));
    expect(screen.queryByText('Late Plan A')).toBeNull();

    act(() => emitPlan('session-b', 'Plan B'));
    expect(screen.getByText('Plan B')).toBeTruthy();
    expect(testState.getPlan).toHaveBeenCalledTimes(2);
  });
});
