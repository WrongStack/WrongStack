/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStore } from '../src/store';
import { resetHqLocalPrefs, setHqFleetPrefs } from '../src/stores/hq-local-prefs';
import { FleetMapView } from '../src/views/fleet-map';
import { HqKanbanInspector } from '../src/views/kanban-inspector';
import { LiveConsoleView } from '../src/views/live-console';
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
  resetHqLocalPrefs();
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

  it('renders the dense operations toolbar and clears compact-list search', () => {
    setHqFleetPrefs({ layout: 'compact' });
    useHqStore.setState({
      snapshot: {
        generatedAt: '2026-08-09T10:00:00Z',
        machines: [
          {
            machineId: 'machine-1',
            hostname: 'devbox',
            clientCount: 1,
            sessionCount: 1,
            agentCount: 1,
            projectIds: ['project-1'],
            lastActivityAt: '2026-08-09T10:00:00Z',
          },
        ],
        projects: [
          {
            projectId: 'project-1',
            projectName: 'WrongStack',
            projectRootDisplay: 'D:/repo',
            machineIds: ['machine-1'],
            activeClients: 1,
            activeSessions: 1,
            activeSubagents: 1,
            totalCostUsd: 0,
            lastActivityAt: '2026-08-09T10:00:00Z',
            status: 'active',
          },
        ],
        clients: [],
        liveSessions: [
          {
            sessionId: 'session-1',
            clientKind: 'tui',
            machineId: 'machine-1',
            hostname: 'devbox',
            projectId: 'project-1',
            projectName: 'WrongStack',
            projectRoot: 'D:/repo',
            status: 'active',
            startedAt: '2026-08-09T09:00:00Z',
            lastActivityAt: '2026-08-09T10:00:00Z',
            agentCount: 1,
            agents: [
              {
                id: 'agent-1',
                name: 'Builder',
                status: 'running',
                iterations: 2,
                toolCalls: 4,
                lastActivityAt: '2026-08-09T10:00:00Z',
              },
            ],
          },
        ],
        totals: { activeSessions: 1, activeAgents: 1, totalCostUsd: 0 },
      } as never,
    });
    mount(<FleetMapView />);

    expect(container?.textContent).toContain('Live operating graph');
    expect(container?.querySelectorAll('.hq-flow-stat')).toHaveLength(4);
    expect(container?.textContent).toContain('WrongStack');

    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search fleet"]');
    expect(search).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'does-not-exist');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container?.textContent).toContain('No fleet entries match this search');

    const clear = container?.querySelector<HTMLButtonElement>('[aria-label="Clear fleet search"]');
    expect(clear).not.toBeNull();
    act(() => clear?.click());
    expect(container?.textContent).toContain('WrongStack');
  });
});

describe('LiveConsoleView', () => {
  it('renders a dense transcript overview and an actionable unselected state', () => {
    useHqStore.setState({
      snapshot: null,
      selectedSessionId: null,
      selectedAgentId: null,
      commandStatuses: [],
    });
    mount(<LiveConsoleView />);

    expect(container?.querySelector('.hq-console-overview')).not.toBeNull();
    expect(container?.querySelectorAll('.hq-console-overview-metric')).toHaveLength(4);
    expect(container?.textContent).toContain('Select an endpoint');
    expect(container?.textContent).toContain('Choose a conversation');
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
  it('renders an intentional coordination empty state before projects report activity', async () => {
    useHqStore.setState({ snapshot: null, events: [] });
    mount(<MailboxView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.querySelector('.hq-mailbox-zero')).not.toBeNull();
    expect(container?.textContent).toContain('Waiting for mailbox traffic');
  });

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
    expect(container?.querySelector('.hq-mailbox-screen')).not.toBeNull();
    expect(container?.querySelectorAll('.hq-mailbox-metric')).toHaveLength(4);
    expect(container?.textContent).toContain('1 message needs review');
    const grouped = [...(container?.querySelectorAll('[role="tab"]') ?? [])].find((element) =>
      element.textContent?.includes('Grouped by project'),
    ) as HTMLButtonElement;
    act(() => grouped.click());
    expect(container?.textContent).toContain('project-1');
    expect(container?.textContent).toContain('Snapshot counters reported');
  });
});
