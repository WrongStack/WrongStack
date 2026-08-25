import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorPanel } from '../../src/components/InspectorPanel';
import { useFleetStore, useKanbanStore, useUIStore } from '../../src/stores';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, opts?: any) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return opts.defaultValue;
      return k;
    },
  }),
}));

describe('InspectorPanel component with universal targets', () => {
  beforeEach(() => {
    useFleetStore.setState({
      agents: new Map(),
      leaderId: undefined,
    });
    useUIStore.setState({
      inspectorOpen: true,
      inspectorTab: 'fleet',
      inspectorTarget: null,
    });
    useKanbanStore.setState({
      activeBoard: {
        id: 'board-1',
        title: 'Core Sprint',
        columns: [],
        tasks: [
          {
            id: 'task-101',
            title: 'Fix authentication cookie issue',
            description: 'Cookies must have SameSite=Lax and Secure in prod.',
            columnId: 'todo',
            priority: 'high',
            assignedAgent: 'agent-sec-1',
          },
        ] as any,
      } as any,
    });
  });

  it('renders standard fleet tabs when no task target is set', () => {
    render(<InspectorPanel />);

    expect(screen.getByTestId('inspector-drawer')).toBeDefined();
  });

  it('renders task details and back button when task target is set', () => {
    useUIStore.getState().openInspectorTarget({
      kind: 'task',
      taskId: 'task-101',
      title: 'Fix authentication cookie issue',
    });

    render(<InspectorPanel />);

    const titles = screen.getAllByText('Fix authentication cookie issue');
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('agent-sec-1')).toBeDefined();
    expect(screen.getByText('Cookies must have SameSite=Lax and Secure in prod.')).toBeDefined();

    // Clicking Back button returns to fleet view
    const backBtn = screen.getByTitle('Back to Fleet');
    fireEvent.click(backBtn);

    expect(useUIStore.getState().inspectorTarget).toEqual({ kind: 'fleet', tab: 'fleet' });
  });
});
