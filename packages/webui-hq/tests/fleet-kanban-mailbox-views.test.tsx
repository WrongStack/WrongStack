/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStore } from '../src/store';
import { FleetMapView } from '../src/views/fleet-map';
import { HqKanbanInspector } from '../src/views/kanban-inspector';
import { MailboxView } from '../src/views/mailbox';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [] }) }),
  );
  useHqStore.setState(useHqStore.getInitialState());
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  localStorage.clear();
  useHqStore.setState(useHqStore.getInitialState());
});

describe('FleetMapView', () => {
  it('distinguishes waiting-for-snapshot from an empty connected fleet', () => {
    useHqStore.setState({ snapshot: null });
    mount(<FleetMapView />);
    expect(container?.textContent).toContain('Waiting for fleet data');

    act(() => {
      useHqStore.setState({
        snapshot: {
          generatedAt: '2026-08-09T10:00:00Z',
          projects: [],
          clients: [],
          machines: [],
          liveSessions: [],
          totals: { activeSessions: 0, activeAgents: 0, totalCostUsd: 0 },
        } as never,
      });
    });
    expect(container?.textContent).toContain('No machines or connected clients yet');
  });
});

describe('HqKanbanInspector', () => {
  it('renders task details, resolved dependencies, warning, deep link, and close action', () => {
    const onClose = vi.fn();
    mount(
      <HqKanbanInspector
        task={
          {
            id: 'task-123456789',
            title: 'Repair release gate',
            description: 'Restore deterministic validation.',
            status: 'blocked',
            priority: 'high',
            assignee: 'agent-a',
            assignmentStatus: 'working',
            dueDate: '2026-08-10T12:00:00Z',
            columnId: 'doing',
            labels: ['ci', 'release'],
            dependsOn: ['dep-123456789'],
          } as never
        }
        board={
          {
            id: 'board-1',
            title: 'Delivery',
            columns: [{ id: 'doing', title: 'Doing', order: 1 }],
            tasks: [],
          } as never
        }
        dependencyTitles={new Map([['dep-123456789', 'Prepare fixtures']])}
        webuiUrl="http://localhost:3466"
        onClose={onClose}
      />,
    );

    expect(container?.textContent).toContain('Repair release gate');
    expect(container?.textContent).toContain('Prepare fixtures');
    expect(container?.textContent).toContain('This task is blocked');
    expect(container?.querySelector('a')?.href).toBe('http://localhost:3466/');
    act(() =>
      (container!.querySelector('[aria-label="Close inspector"]') as HTMLButtonElement).click(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('MailboxView', () => {
  it('renders snapshot counters and switches to grouped project detail', async () => {
    useHqStore.setState({
      snapshot: {
        generatedAt: '2026-08-09T10:00:00Z',
        projects: [
          {
            projectId: 'project-1',
            projectName: 'WrongStack',
            projectRootDisplay: 'D:/repo',
            machineIds: ['machine-1'],
            activeClients: 1,
            activeSessions: 1,
            activeSubagents: 0,
            totalCostUsd: 0,
            lastActivityAt: '2026-08-09T10:00:00Z',
            status: 'active',
          },
        ],
        clients: [],
        machines: [],
        liveSessions: [],
        mailboxes: [
          {
            mailboxId: 'project-1:mailbox',
            projectId: 'project-1',
            scope: 'project',
            messageCount: 2,
            unreadCount: 1,
            incompleteCount: 1,
            highPriorityCount: 1,
            onlineAgentCount: 1,
            lastActivityAt: '2026-08-09T10:00:00Z',
          },
        ],
        totals: {
          activeSessions: 1,
          activeAgents: 1,
          totalCostUsd: 0,
          unreadMailboxMessages: 1,
          incompleteMailboxMessages: 1,
        },
      } as never,
      events: [],
    });
    mount(<MailboxView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Mailbox Activity — 1 project');
    expect(container?.textContent).toContain('1 unread · 1 incomplete');
    const grouped = [...(container?.querySelectorAll('[role="tab"]') ?? [])].find((element) =>
      element.textContent?.includes('Grouped by project'),
    ) as HTMLButtonElement;
    act(() => grouped.click());
    expect(container?.textContent).toContain('project-1');
    expect(container?.textContent).toContain('Snapshot counters reported');
  });
});
