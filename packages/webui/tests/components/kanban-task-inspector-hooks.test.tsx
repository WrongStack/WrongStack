import { fireEvent, render, screen, within } from '@testing-library/react';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted reference so the vi.mock factories (which run before module
// initialization) can read the same mutable that tests assign in
// beforeEach, and so both factories share a single action+state shape
// (diverging mocks would silently pass today and break tomorrow).
const { mockRefs, baseState } = vi.hoisted(() => {
  const mockRefs = { activeBoard: null as KanbanBoard | null };
  const baseState = () => ({
    boards: [] as KanbanBoard[],
    activeBoardId: 'board-1' as string | null,
    get activeBoard() {
      return mockRefs.activeBoard;
    },
    loading: false,
    error: null as string | null,
    queueHealth: null,
    supervisorSnapshot: null,
    lastOutboundAction: null as string | null,
    setLoading: vi.fn(),
    setActiveBoardId: vi.fn(),
    setError: vi.fn(),
    sendKanban: vi.fn(),
    transitionTask: vi.fn(),
    dispatchTask: vi.fn(),
    moveTask: vi.fn(),
    removeTask: vi.fn(),
    boardHistory: [],
    fetchBoardHistory: vi.fn(),
  });
  return { mockRefs, baseState };
});

vi.mock('@/stores', () => {
  const useKanbanStore = Object.assign(() => baseState(), {
    getState: () => baseState(),
  });
  return {
    useConfigStore: Object.assign(() => ({ wsUrl: 'ws://localhost:0' }), {}),
    useSessionStore: () => ({ session: { id: 'test-session' } }),
    useFleetStore: Object.assign(
      (selector: (s: { agents: Map<string, unknown> }) => unknown) =>
        selector({ agents: new Map() }),
      {},
    ),
    useKanbanStore,
  };
});

vi.mock('@/stores/kanban-store', () => {
  const useKanbanStore = Object.assign(() => baseState(), {
    getState: () => baseState(),
  });
  return { useKanbanStore };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    client: { on: vi.fn(() => vi.fn), send: vi.fn() },
    listSavedProviders: vi.fn(),
    listProviderModels: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProviderModels', () => ({
  useProviderModels: () => [],
}));

vi.mock('@/hooks/useKanbanMeta', () => ({
  useKanbanMeta: () => ({
    tools: [],
    skills: [],
    fallbackProfiles: {},
    sessionProvider: '',
    sessionModel: '',
  }),
}));

vi.mock('@/hooks/useScrollPosition', () => ({
  useScrollPosition: () => ({ current: null }),
}));

vi.mock('@/lib/kanban-cleaner', () => ({
  auditKanbanBoard: () => null,
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    handlers: new Map<string, (message: unknown) => void>(),
    on(
      this: { handlers: Map<string, (message: unknown) => void> },
      type: string,
      handler: (message: unknown) => void,
    ) {
      this.handlers.set(type, handler);
      return () => this.handlers.delete(type);
    },
    send: vi.fn(),
  }),
}));

// No i18n mock: the real module bundles the English catalog inline and
// initialises on first import, so `t()` resolves synchronously. The assertions
// below match on rendered English copy ("Task inspector"), which is what a user
// actually sees — a key-returning stub would silently pass even if the key were
// wrong or missing.

// Minimal task + board fixtures
function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Test Task',
    columnId: 'col-1',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as KanbanTask;
}

function makeBoard(task: KanbanTask | null): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Test Board',
    version: 1,
    columns: [{ id: 'col-1', title: 'To Do', order: 0 }],
    tasks: task ? [task] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as KanbanBoard;
}

// We import KanbanView dynamically after mocks are set up.
const { KanbanView, TASK_ACTIVITY_LOAD_LIMIT, deriveTaskCardIntelligence } = await import(
  '@/components/KanbanView'
);

// Helper to reimport KanbanView fresh after mock state changes,
// so the `selectedTask` derived value recomputes from the mock store.
function renderKanban() {
  return render(<KanbanView onClose={vi.fn()} />);
}

describe('KanbanView — TaskInspector hook-order regression (React error 310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.activeBoard = null;
  });

  it('does not render an empty inspector when no task is selected', () => {
    // task=null path of TaskInspector — useScrollPosition(enabled=false)
    // must still be called unconditionally at the top of the component.
    expect(() => renderKanban()).not.toThrow();
    expect(screen.queryByRole('complementary', { name: 'Task inspector' })).toBeNull();
  });

  it('loads the maximum supported task activity history for audit and export', () => {
    expect(TASK_ACTIVITY_LOAD_LIMIT).toBe(5_000);
  });

  it('opens the inspector only after a task card is selected', () => {
    const task = makeTask();
    mockRefs.activeBoard = makeBoard(task);
    renderKanban();

    expect(screen.queryByRole('complementary', { name: 'Task inspector' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Select task: ${task.title}` }));

    expect(screen.getByRole('complementary', { name: 'Task inspector' })).toBeTruthy();
    // Definition is the landing tab: the contract is what you read first.
    expect(screen.getByDisplayValue(task.title)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Definition/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    // Recording an outcome belongs to the card's history, so it lives one tab
    // over rather than at the bottom of a single long scroll.
    expect(screen.queryByLabelText('Task activity kind')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.getByLabelText('Task activity kind')).toBeTruthy();
    expect(screen.getByLabelText('Task activity outcome')).toBeTruthy();
    expect(screen.getByLabelText('Task activity details')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record task decision or outcome' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Definition/ }));

    const inspector = screen.getByRole('complementary', { name: 'Task inspector' });
    expect(inspector.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand task details' }));
    expect(inspector.getAttribute('data-expanded')).toBe('true');
    expect(inspector.className).toContain('fixed');
    expect(inspector.className).toContain('inset-0');
    expect(inspector.className).toContain('h-dvh');
    expect(inspector.className).toContain('w-screen');
    expect(inspector.className).toContain('bg-card');
    expect(inspector.className).not.toContain('bg-card/40');
    expect(inspector.className).toContain('transition-none');
    expect(screen.getByRole('button', { name: 'Collapse task details' })).toBeTruthy();

    fireEvent.click(screen.getByTitle('Close'));
    expect(screen.queryByRole('complementary', { name: 'Task inspector' })).toBeNull();
  });

  it('keeps status and the blocking dependency pinned across every tab', () => {
    const blocker = makeTask({ id: 'dep-1', title: 'Migrate schema', status: 'pending' });
    const blocked = makeTask({ id: 'task-1', title: 'Backfill rows', dependsOn: ['dep-1'] });
    mockRefs.activeBoard = {
      ...makeBoard(blocked),
      tasks: [blocker, blocked],
    } as KanbanBoard;
    renderKanban();
    fireEvent.click(screen.getByRole('button', { name: `Select task: ${blocked.title}` }));

    // Whether this card can move is not a per-tab question, so the answer may
    // never depend on which tab happens to be open.
    for (const tab of ['Definition', 'Execution', 'Evidence', 'Breakdown', 'History']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(tab) }));
      const spine = screen.getByRole('region', { name: 'Task status' });
      expect(within(spine).getByText(/Migrate schema/)).toBeTruthy();
      expect(within(spine).getByText('pending')).toBeTruthy();
    }
  });

  it('opens a task with object-valued provider metadata without rendering the object', () => {
    const provider = {
      id: 'openai',
      apiKey: 'must-not-render',
      baseUrl: 'https://example.invalid',
      debugStream: false,
      reasoningEffort: 'high',
    };
    const task = makeTask({
      assignment: {
        status: 'running',
        provider: provider as unknown as string,
        model: 'gpt-5.4',
      },
    });
    mockRefs.activeBoard = makeBoard(task);
    renderKanban();

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: `Select task: ${task.title}` })),
    ).not.toThrow();
    expect(screen.getByRole('complementary', { name: 'Task inspector' })).toBeTruthy();
    // Assignment metadata is execution detail; the guard is that the provider
    // renders as its id and never leaks the raw object (including the key).
    fireEvent.click(screen.getByRole('tab', { name: /Execution/ }));
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0);
    expect(screen.queryByText('must-not-render')).toBeNull();
  });

  it('derives at-a-glance owner, route, attempt, blocker, failure, and presence telemetry', () => {
    const dependency = makeTask({
      id: 'dependency-1',
      title: 'Review dependency',
      status: 'review',
    });
    const task = makeTask({
      dependsOn: [dependency.id],
      assignment: {
        agentId: 'agent-1',
        name: 'Release Agent',
        status: 'failed',
        provider: 'openai',
        model: 'gpt-5.4',
        fallbackProfile: 'resilient',
        fallbackModels: ['anthropic/claude-opus'],
        attempt: 2,
        maxAttempts: 4,
        error: 'Primary route timed out.',
      },
    });
    const board = {
      ...makeBoard(task),
      tasks: [task, dependency],
      presence: [
        {
          id: 'session-live:observer',
          sessionId: 'session-live',
          agentId: 'observer',
          taskId: task.id,
          firstSeenAt: '2026-07-16T08:00:00.000Z',
          lastSeenAt: '2026-07-16T08:01:00.000Z',
          activeUntil: '2026-07-16T08:03:00.000Z',
          active: true,
        },
      ],
    } as KanbanBoard;

    expect(deriveTaskCardIntelligence(board, task)).toMatchObject({
      owner: 'Release Agent',
      route: 'openai/gpt-5.4',
      blockers: 1,
      attempts: '2/4',
      fallbackCount: 2,
      activeUsers: 1,
      failed: true,
      criticalRisks: 1,
      warningRisks: 1,
    });
  });
});
