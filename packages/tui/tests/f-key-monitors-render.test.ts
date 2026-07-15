import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '@wrongstack/core';
import type { FleetEntry } from '../src/app.js';
import { ProjectPicker } from '../src/components/project-picker.js';
import { FleetMonitor } from '../src/components/fleet-monitor.js';
import { AgentsMonitor } from '../src/components/agents-monitor.js';
import { WorktreeMonitor } from '../src/components/worktree-monitor.js';
import { PlanPanel } from '../src/components/plan-panel.js';
import { TodosMonitor } from '../src/components/todos-monitor.js';
import { QueuePanel } from '../src/components/queue-panel.js';
import { ProcessListMonitor } from '../src/components/process-list.js';
import { GoalPanel } from '../src/components/goal-panel.js';
import { SessionsPanel } from '../src/components/sessions-panel.js';

function fleetEntry(overrides: Partial<FleetEntry> = {}): FleetEntry {
  return {
    id: 'worker-1',
    name: 'researcher',
    status: 'running',
    streamingText: '',
    iterations: 3,
    toolCalls: 7,
    recentTools: [],
    recentMessages: [],
    cost: 0.0123,
    startedAt: 1_000,
    lastEventAt: 2_000,
    provider: 'openai',
    model: 'gpt-5',
    ...overrides,
  };
}

describe('F1–F10 monitor presentation', () => {
  it('renders F1 as a project command center with filter and actions', () => {
    const view = render(
      React.createElement(ProjectPicker, {
        items: [
          {
            key: 'wrongstack',
            label: 'WrongStack',
            subtitle: 'Terminal coding agent',
            meta: 'main',
            kind: 'project',
          },
          { key: '__divider__', label: '', kind: 'action' },
          { key: 'new-session', label: 'New session', kind: 'action' },
        ],
        selected: 0,
        filter: 'wrong',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('PROJECTS');
    expect(frame).toContain('workspace switcher');
    expect(frame).toContain('WrongStack');
    expect(frame).toContain('wrong');
    expect(frame).toContain('Enter');
    view.unmount();
  });

  it('keeps F1 inside a narrow and short terminal while preserving selection', async () => {
    const view = render(
      React.createElement(ProjectPicker, {
        items: Array.from({ length: 24 }, (_, index) => ({
          key: `project-${index + 1}`,
          label: `project-${index + 1}`,
          subtitle: 'A deliberately verbose workspace subtitle for responsive testing',
          kind: 'project' as const,
        })),
        selected: 16,
        filter: '',
      }),
    );
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 52 });
    Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 16 });
    process.stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('project-17');
    expect(frame).toContain('hidden');
    expect(Math.max(...frame.split('\n').map((line) => line.length))).toBeLessThanOrEqual(54);
    view.unmount();
  });

  it('renders F2 fleet capacity and compact worker telemetry', () => {
    const view = render(
      React.createElement(FleetMonitor, {
        entries: { worker: fleetEntry() },
        totalCost: 0.0123,
        totalTokens: { input: 2_400, output: 900 },
        maxConcurrent: 4,
        nowTick: 4_000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('FLEET CONTROL');
    expect(frame).toContain('CAPACITY');
    expect(frame).toContain('researcher');
    expect(frame).toContain('L3 7t');
    view.unmount();
  });

  it('shows all agents in the left sidebar and navigates the detail panel via arrows', async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => {
        const id = `worker-${index + 1}`;
        return [id, fleetEntry({ id, name: id, startedAt: index + 1 })];
      }),
    );
    const view = render(
      React.createElement(AgentsMonitor, {
        entries,
        totalCost: 0.2,
        nowTick: 10_000,
        onClose: vi.fn(),
      }),
    );

    // Left sidebar shows all agents; right panel shows the first agent's detail
    expect(view.lastFrame() ?? '').toContain('worker-1');
    expect(view.lastFrame() ?? '').toContain('worker-12');
    expect(view.lastFrame() ?? '').toContain('worker-18');
    // Navigate down 17 times to reach the last agent
    for (let index = 0; index < 17; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    // Right panel now shows worker-18's detail
    expect(frame).toContain('worker-18');
    expect(frame).toContain('openai');
    view.unmount();
  });

  it('renders F4 conflict-first worktree context', () => {
    const view = render(
      React.createElement(WorktreeMonitor, {
        worktrees: {
          auth: {
            branch: 'wstack/ap/auth-fix',
            baseBranch: 'main',
            ownerLabel: 'implement',
            status: 'needs-review',
            insertions: 18,
            deletions: 4,
            files: 3,
            allocatedAt: 1_000,
            conflictFiles: ['src/auth.ts'],
          },
        },
        baseBranch: 'main',
        nowTick: 5_000,
        onClose: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('WORKTREES');
    expect(frame).toContain('NEEDS-REVIEW');
    expect(frame).toContain('conflicts');
    expect(frame).toContain('src/auth.ts');
    view.unmount();
  });

  it('lets F4 inspect worktrees beyond the initial card window', async () => {
    const worktrees = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const branch = `wstack/ap/branch-${index + 1}`;
        return [
          branch,
          {
            branch,
            ownerLabel: 'implement',
            status: 'active',
            insertions: index + 1,
            deletions: 0,
            files: 1,
            allocatedAt: 1_000,
          },
        ];
      }),
    );
    const view = render(
      React.createElement(WorktreeMonitor, {
        worktrees,
        baseBranch: 'main',
        nowTick: 5_000,
        onClose: vi.fn(),
      }),
    );
    for (let index = 0; index < 6; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('branch-7');
    expect(frame).toContain('worktrees');
    view.unmount();
  });

  it('renders F5 loading state inside the shared plan shell', async () => {
    const view = render(
      React.createElement(PlanPanel, {
        projectRoot: process.cwd(),
        sessionId: `render-test/${Date.now()}`,
        onClose: vi.fn(),
      }),
    );
    expect(view.lastFrame() ?? '').toContain('PLAN');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(view.lastFrame() ?? '').toMatch(/No plan items yet|Loading plan/);
    view.unmount();
  });

  it('renders F6 progress and status-grouped todo rows', () => {
    const todos = [
      {
        id: '1',
        content: 'Ship the responsive panel shell',
        status: 'in_progress',
        activeForm: 'Shipping panel shell',
      },
      { id: '2', content: 'Run regression tests', status: 'pending' },
      { id: '3', content: 'Audit F-key screens', status: 'completed' },
    ] as TodoItem[];
    const view = render(React.createElement(TodosMonitor, { todos }));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('TODOS');
    expect(frame).toContain('PROGRESS');
    expect(frame).toContain('Shipping panel shell');
    expect(frame).toContain('Run regression tests');
    view.unmount();
  });

  it('lets F6 inspect todos beyond the terminal fold', async () => {
    const todos = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 1),
      content: `todo-item-${index + 1}`,
      status: 'pending',
    })) as TodoItem[];
    const view = render(React.createElement(TodosMonitor, { todos }));
    for (let index = 0; index < 15; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('todo-item-16');
    expect(frame).toContain('↑');
    view.unmount();
  });

  it('renders F7 at full panel width with queue stage metadata', () => {
    const message = 'Please preserve this long queued message through the full-width queue layout';
    const view = render(
      React.createElement(QueuePanel, {
        items: [{ id: 1, displayText: message, blocks: [] }],
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('MESSAGE QUEUE');
    expect(frame).toContain('NEXT');
    expect(frame).toContain('long queued message through the full-width queue lay');
    view.unmount();
  });

  it('lets F7 inspect messages beyond the initial viewport', async () => {
    const view = render(
      React.createElement(QueuePanel, {
        items: Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          displayText: `queued-message-${index + 1}`,
          blocks: [],
        })),
      }),
    );
    for (let index = 0; index < 15; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('queued-message-16');
    expect(frame).toContain('earlier');
    view.unmount();
  });

  it('renders F8 safety-oriented process chrome', () => {
    const view = render(React.createElement(ProcessListMonitor));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('PROCESSES');
    expect(frame).toContain('CIRCUIT BREAKER');
    expect(frame).toContain('Enter');
    expect(frame).toContain('stop');
    view.unmount();
  });

  it('renders F9 mission, progress and coordinator controls', () => {
    const view = render(
      React.createElement(GoalPanel, {
        goal: {
          goal: 'Refresh every function-key monitor',
          goalState: 'active',
          iterations: 4,
          progress: 60,
          progressTrend: 'steady',
          deliverables: ['[x] Shared shell', 'Responsive sessions'],
        },
        coordinatorRunning: false,
        onCoordinatorStart: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('GOAL');
    expect(frame).toContain('MISSION');
    expect(frame).toContain('60%');
    expect(frame).toContain('DELIVERABLES');
    expect(frame).toContain('start coordinator');
    view.unmount();
  });

  it('lets F9 inspect deliverables beyond the terminal fold', async () => {
    const view = render(
      React.createElement(GoalPanel, {
        goal: {
          goal: 'Complete every deliverable',
          goalState: 'active',
          iterations: 2,
          deliverables: Array.from({ length: 16 }, (_, index) => `deliverable-${index + 1}`),
        },
      }),
    );
    for (let index = 0; index < 12; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('deliverable-13');
    expect(frame).toContain('earlier');
    view.unmount();
  });

  it('renders F10 with only the selected session expanded', () => {
    const view = render(
      React.createElement(SessionsPanel, {
        sessions: [
          {
            sessionId: '2026-07-14/session-a',
            projectName: 'WrongStack',
            projectSlug: 'wrongstack',
            workingDir: process.cwd(),
            gitBranch: 'feature/tui',
            status: 'active',
            pid: 4242,
            startedAt: new Date().toISOString(),
            agentCount: 1,
            agents: [
              {
                id: 'leader',
                name: 'Leader',
                status: 'running',
                currentTool: 'typecheck',
                iterations: 8,
                toolCalls: 14,
                lastActivityAt: new Date().toISOString(),
              },
            ],
          },
        ],
        busy: false,
        selected: 0,
        currentSessionId: '2026-07-14/session-a',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('SESSIONS');
    expect(frame).toContain('WrongStack');
    expect(frame).toContain('feature/tui');
    expect(frame).toContain('typecheck');
    expect(frame).toContain('Enter');
    view.unmount();
  });
});
