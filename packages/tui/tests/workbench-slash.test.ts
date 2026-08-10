import type { KanbanWorkbenchSnapshot } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchSlashCommand, renderWorkbenchReport } from '../src/workbench-slash.js';

const mockGetKanbanWorkbench = vi.fn();

vi.mock('@wrongstack/kanban', () => ({
  getKanbanWorkbench: (...args: unknown[]) => mockGetKanbanWorkbench(...args),
}));

const snapshot = {
  generatedAt: '2026-08-09T12:00:00.000Z',
  boardCount: 2,
  totals: { active: 3, now: 1, next: 2, blocked: 0, review: 0, failed: 0, completed: 4 },
  flow: [
    { id: 'capture', label: 'Captured', count: 2, explanation: 'Captured.' },
    { id: 'ready', label: 'Ready', count: 2, explanation: 'Ready.' },
    { id: 'execute', label: 'Executing', count: 1, explanation: 'Executing.' },
    { id: 'review', label: 'Review', count: 0, explanation: 'Review.' },
    { id: 'verified', label: 'Verified', count: 4, explanation: 'Verified.' },
  ],
  lanes: {
    now: {
      total: 1,
      omitted: 0,
      items: [
        {
          lane: 'now',
          title: 'Ship release',
          boardTitle: 'Release board',
          source: 'managed',
          reason: 'Live agent execution',
        },
      ],
    },
    next: { total: 2, omitted: 2, items: [] },
    blocked: { total: 0, omitted: 0, items: [] },
    review: { total: 0, omitted: 0, items: [] },
  },
  alerts: [{ severity: 'critical', title: 'Stale execution lease', detail: 'Lease expired.' }],
  alertTotal: 1,
  alertsOmitted: 0,
} as unknown as KanbanWorkbenchSnapshot;

beforeEach(() => mockGetKanbanWorkbench.mockReset());

describe('createWorkbenchSlashCommand', () => {
  it('loads the shared bounded projection', async () => {
    mockGetKanbanWorkbench.mockResolvedValue(snapshot);
    const command = createWorkbenchSlashCommand({ projectRoot: 'D:/project' });

    const result = await command.run('');

    expect(mockGetKanbanWorkbench).toHaveBeenCalledWith('D:/project', {
      limitPerLane: 3,
      alertLimit: 3,
    });
    expect(result).toMatchObject({ message: expect.stringContaining('Kanban Workbench') });
  });
});

describe('renderWorkbenchReport', () => {
  it('shows flow, reasons, bounded omissions, source, and alerts', () => {
    const output = renderWorkbenchReport(snapshot);

    expect(output).toContain('Captured 2 → Ready 2 → Executing 1 → Review 0 → Verified 4');
    expect(output).toContain('◆ Ship release · Release board [managed]');
    expect(output).toContain('Live agent execution');
    expect(output).toContain('+2 more hidden by focus limit');
    expect(output).toContain('Stale execution lease');
  });
});
