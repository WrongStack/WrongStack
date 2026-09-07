import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalView } from '../../src/components/GoalView.js';
import {
  useChatStore,
  useGoalAssessStore,
  useGoalRunStore,
  useWorktreeStore,
} from '../../src/stores/index.js';

const sendMock = vi.fn();
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    client: {
      send: sendMock,
    },
  }),
}));

vi.mock('@/components/activity-bar/nav', () => ({
  showPanel: vi.fn(),
}));

describe('GoalView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGoalRunStore.getState().clear();
    useGoalAssessStore.getState().clear();
    useChatStore.getState().clearMessages();
    useWorktreeStore.setState({ worktrees: [], baseBranch: 'main' });
  });

  afterEach(cleanup);

  it('mounts, fetches goal list and state, and renders goal start form', () => {
    const { container } = render(<GoalView onClose={() => {}} />);

    expect(sendMock).toHaveBeenCalledWith({ type: 'goal.list' });
    expect(sendMock).toHaveBeenCalledWith({ type: 'goal.state' });

    expect(container.querySelector('textarea')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Goal/i })).toBeTruthy();
  });

  it('submits goal and enters planning state with cancel option', async () => {
    const { container } = render(<GoalView onClose={() => {}} />);

    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Build user auth system' } });

    const startBtn = screen.getByRole('button', { name: /Start Goal/i });
    fireEvent.click(startBtn);

    expect(sendMock).toHaveBeenCalledWith({
      type: 'goal.start',
      payload: expect.objectContaining({
        title: 'Build user auth system',
        autonomous: true,
      }),
    });

    // In planning state, planning loader and cancel button appear
    expect(screen.getByText(/Planning phases…/i)).toBeTruthy();
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelBtn);

    expect(sendMock).toHaveBeenCalledWith({
      type: 'goal.stop',
      payload: {},
    });
  });

  it('renders interactive board view when phases exist', () => {
    useGoalRunStore.setState({
      title: 'Setup Database',
      status: 'running',
      overallPercent: 50,
      autonomous: true,
      goal: 'Setup PostgreSQL schema and migrations',
      phases: [
        {
          id: 'phase-1',
          name: 'Schema Design',
          status: 'completed',
          percent: 100,
          tasks: [
            {
              id: 'task-1',
              title: 'Create users table',
              status: 'completed',
              tags: [],
            },
          ],
        },
        {
          id: 'phase-2',
          name: 'Migrations',
          status: 'running',
          percent: 0,
          tasks: [
            {
              id: 'task-2',
              title: 'Add auth migration script',
              status: 'in_progress',
              tags: [],
            },
          ],
        },
      ] as any,
    });

    render(<GoalView onClose={() => {}} />);

    // Header items
    expect(screen.getByRole('heading', { name: 'Setup Database' })).toBeTruthy();
    expect(screen.getByText('Setup PostgreSQL schema and migrations')).toBeTruthy();

    // Controls: autonomous toggle, pause button, stop button
    const autoBtn = screen.getByRole('button', { name: /Autonomous/i });
    fireEvent.click(autoBtn);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'goal.toggleAutonomous',
      payload: {},
    });

    const pauseBtn = screen.getByRole('button', { name: /Pause/i });
    fireEvent.click(pauseBtn);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'goal.pause',
      payload: {},
    });

    // BoardView content: Phase columns
    expect(screen.getByText('Schema Design')).toBeTruthy();
    expect(screen.getByText('Migrations')).toBeTruthy();
    expect(screen.getByText('Create users table')).toBeTruthy();
    expect(screen.getByText('Add auth migration script')).toBeTruthy();

    // Layout switcher: switch to status swimlanes
    const statusLayoutBtn = screen.getByRole('button', { name: /Status/i });
    fireEvent.click(statusLayoutBtn);
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('renders done controls (New and Revert) when run is finished', () => {
    useGoalRunStore.setState({
      title: 'Completed Run',
      status: 'completed',
      overallPercent: 100,
      phases: [
        {
          id: 'p1',
          name: 'Done Phase',
          status: 'completed',
          tasks: [],
        },
      ] as any,
    });

    render(<GoalView onClose={() => {}} />);

    // New button resets run
    const newBtn = screen.getByRole('button', { name: /New/i });
    fireEvent.click(newBtn);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'goal.clear',
      payload: {},
    });
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<GoalView onClose={onClose} />);

    // Close button in header
    const closeBtns = screen.getAllByRole('button');
    const xBtn = closeBtns.find((b) => b.querySelector('svg.lucide-x'));
    expect(xBtn).toBeTruthy();
    fireEvent.click(xBtn!);
    expect(onClose).toHaveBeenCalled();
  });
});
