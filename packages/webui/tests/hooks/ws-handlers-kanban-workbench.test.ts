import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn(), sendAbort: vi.fn() }),
}));

const { WS_HANDLERS } = await import('../../src/hooks/ws-handlers');
const { useKanbanStore } = await import('../../src/stores/kanban-store');

beforeEach(() => {
  useKanbanStore.setState({ workbench: null, loading: true, error: null });
});

describe('kanban.workbench websocket projection', () => {
  it('routes the server response into the Kanban store', () => {
    const snapshot = {
      generatedAt: '2026-08-09T12:00:00.000Z',
      boardCount: 1,
      totals: { active: 1, now: 1, next: 0, blocked: 0, review: 0, failed: 0, completed: 0 },
      flow: [],
      lanes: {},
      alerts: [],
      alertTotal: 0,
      alertsOmitted: 0,
    };
    const handler = WS_HANDLERS['kanban.workbench'];

    expect(handler).toBeTypeOf('function');
    handler?.({
      type: 'kanban.workbench',
      payload: { success: true, data: snapshot },
    } as never);

    expect(useKanbanStore.getState()).toMatchObject({
      workbench: snapshot,
      loading: false,
      error: null,
    });
  });
});
