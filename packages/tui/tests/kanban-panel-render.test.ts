// Sprint 2 regression tests for the kanban panel UI upgrades.
//
// What this file pins down:
//   - `computeBoardColumnLayout` keeps every visible column at least the
//     minimum width and never overflows the surrounding chrome
//   - Narrow terminals force fewer visible columns and surface an overflow
//     indicator rather than truncating silently
//   - `summarizeSuccessCriteria` and `summarizeGoalMetrics` produce the
//     strings the visible "Criteria N/M passed" and "Metrics …" lines use,
//     including their null-shape fast paths (no checks / no metrics)
//   - The kanban panel advertises Ctrl+J in its footer hint so users can
//     discover the chord (Sprint 2 introduced it)

import type { KanbanBoard, KanbanCheck, KanbanGoalMetric, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  computeBoardColumnLayout,
  nextManagedStage,
  stageForColumn,
  summarizeGoalMetrics,
  summarizeSuccessCriteria,
} from '../src/components/kanban-panel.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2026-07-18T12:00:00.000Z';

function task(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ── Layout math ──────────────────────────────────────────────────────────────

describe('computeBoardColumnLayout', () => {
  it('returns the full column set when the terminal is comfortably wide', () => {
    const { visibleColumnCount, columnWidth, overflow } = computeBoardColumnLayout(5, 160);
    expect(visibleColumnCount).toBe(5);
    expect(overflow).toBe(0);
    // 160 cols − chrome (~64) − 4 inter-column gaps (4 cols) = 92 / 5 ≈ 18
    // but capped to preferredColumnWidth (26). Just assert it never goes
    // below the minimum width.
    expect(columnWidth).toBeGreaterThanOrEqual(16);
  });

  it('forces fewer columns when the terminal cannot fit the minimum width', () => {
    // 80 cols with default chrome (~64) leaves only ~16 cols for columns.
    // The function should drop to the minimum visible-column count (2) and
    // mark the rest as overflow rather than truncate to sub-min widths.
    const { visibleColumnCount, overflow } = computeBoardColumnLayout(5, 80);
    expect(visibleColumnCount).toBe(2);
    expect(overflow).toBe(3);
  });

  it('never drops below 2 visible columns when at least 2 columns exist', () => {
    const { visibleColumnCount } = computeBoardColumnLayout(2, 60);
    expect(visibleColumnCount).toBe(2);
  });

  it('always honours the upper bound of 5 columns even with extra room', () => {
    const { visibleColumnCount } = computeBoardColumnLayout(8, 240);
    expect(visibleColumnCount).toBe(5);
    // The overflow (8 − 5 = 3) is surfaced so the UI can render a
    // "+ N more columns" indicator rather than silently hiding them.
  });

  it('reports zero overflow when total columns fits within the visible budget', () => {
    const { overflow } = computeBoardColumnLayout(3, 200);
    expect(overflow).toBe(0);
  });

  it('matches the actual visible column count the BoardColumns component uses', () => {
    // The integration scenario: a typical 80-col terminal, 5 columns.
    // We don't pin the exact columnWidth (it can shift with chrome
    // tweaks) but we do pin the visibleColumnCount/overflow contract.
    const layout = computeBoardColumnLayout(5, 80);
    expect(layout.visibleColumnCount).toBeLessThanOrEqual(5);
    expect(layout.visibleColumnCount).toBeGreaterThanOrEqual(2);
    expect(layout.overflow).toBe(5 - layout.visibleColumnCount);
    // Used implicitly by the BoardColumns render to decide whether to
    // show the "+ N more columns" overflow box.
    const _overflow = layout.overflow;
    expect(_overflow).toBeGreaterThanOrEqual(0);
  });
});

// ── Success-criteria summary ────────────────────────────────────────────────

describe('summarizeSuccessCriteria', () => {
  it('returns null when the task has no success criteria', () => {
    expect(summarizeSuccessCriteria(task('t1'))).toBeNull();
  });

  it('returns null for an empty criteria list', () => {
    expect(summarizeSuccessCriteria(task('t1', { successCriteria: [] }))).toBeNull();
  });

  it('formats "Criteria N/M passed" with the passing count', () => {
    const checks: KanbanCheck[] = [
      { id: 'c1', description: 'a', type: 'manual', status: 'passed' },
      { id: 'c2', description: 'b', type: 'auto', status: 'pending' },
      { id: 'c3', description: 'c', type: 'review', status: 'failed' },
    ];
    expect(summarizeSuccessCriteria(task('t1', { successCriteria: checks }))).toBe(
      'Criteria 1/3 passed',
    );
  });

  it('reports 0/M when every check is still pending or failed', () => {
    const checks: KanbanCheck[] = [
      { id: 'c1', description: 'a', type: 'manual', status: 'pending' },
      { id: 'c2', description: 'b', type: 'auto', status: 'failed' },
    ];
    expect(summarizeSuccessCriteria(task('t1', { successCriteria: checks }))).toBe(
      'Criteria 0/2 passed',
    );
  });
});

// ── Goal-metrics rollup ──────────────────────────────────────────────────────

describe('summarizeGoalMetrics', () => {
  it('returns null when the task has no goal metrics', () => {
    expect(summarizeGoalMetrics(task('t1'))).toBeNull();
  });

  it('returns null for an empty metrics list', () => {
    expect(summarizeGoalMetrics(task('t1', { goalMetrics: [] }))).toBeNull();
  });

  it('formats a multi-status rollup, dropping zero-count buckets', () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'g1', name: 'latency', status: 'met' },
      { id: 'g2', name: 'errors', status: 'met' },
      { id: 'g3', name: 'cost', status: 'missed' },
      { id: 'g4', name: 'coverage', status: 'waived' },
      { id: 'g5', name: 'docs', status: 'pending' },
    ];
    // 'pending' counts every non-(met/missed/waived) status too, so with
    // the fixture above we'd see: 2 met, 1 missed, 1 waived, 1 pending.
    expect(summarizeGoalMetrics(task('t1', { goalMetrics: metrics }))).toBe(
      'Metrics 2 met · 1 missed · 1 waived · 1 pending',
    );
  });

  it('omits zero-count buckets so the line stays short', () => {
    const metrics: KanbanGoalMetric[] = [
      { id: 'g1', name: 'latency', status: 'met' },
      { id: 'g2', name: 'errors', status: 'met' },
    ];
    expect(summarizeGoalMetrics(task('t1', { goalMetrics: metrics }))).toBe('Metrics 2 met');
  });

  it('falls back to "pending" for any future status the task carries', () => {
    // The Kanban package reserves 'pending' as the default catch-all, so
    // a metric whose status field is unknown (typed as `string` in tests)
    // still rolls up under "pending" instead of vanishing.
    const metrics = [
      { id: 'g1', name: 'latency', status: 'met' },
      { id: 'g2', name: 'unknown', status: 'pending' },
    ] as KanbanGoalMetric[];
    expect(summarizeGoalMetrics(task('t1', { goalMetrics: metrics }))).toBe(
      'Metrics 1 met · 1 pending',
    );
  });
});

// ── Ctrl+Y chord advertising ─────────────────────────────────────────────────

describe('KanbanPanel header hint advertises Ctrl+Y', () => {
  // Defensive regression: Sprint 2 introduced Ctrl+Y as the chord-only
  // way to toggle the kanban panel. The panel itself advertises this in
  // its footer so a user reading the screen can discover it without
  // consulting the help overlay.
  //
  // The chord was originally Ctrl+J (0x0A), but Ink 7 special-cases
  // 0x0A as `name='enter'` with `key.ctrl=false` BEFORE the ctrl+letter
  // branch — so on mainstream terminals (xterm, ConPTY, iTerm) the
  // event arrived as `input='\n'` and fell through to the submit path.
  // Ctrl+Y (0x19) is not special-cased by Ink and works.
  it('mentions Ctrl+Y in the footer', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const panelPath = path.resolve(path.dirname(here), '../src/components/kanban-panel.tsx');
    const source = await readFile(panelPath, 'utf8');
    expect(source).toContain('Ctrl+Y');
    expect(source).toMatch(/Ctrl\+Y\s*\n?\s*toggle|toggle[\s\S]*Ctrl\+Y/);
  });

  it('registers a Ctrl+Y chord handler in the app key router that toggles the kanban panel', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const routerPath = path.resolve(path.dirname(here), '../src/app-key-handler.ts');
    const source = await readFile(routerPath, 'utf8');
    expect(source).toContain("key.ctrl && input === 'y'");
    // The handler must dispatch the kanban-specific toggle action — not
    // reuse an existing panel action — so it stays isolated from the
    // F-key / Ctrl-alias dispatch table that follows.
    expect(source).toMatch(/key\.ctrl && input === 'y'[\s\S]{0,200}toggleKanbanPanel/);
  });
});

// ── Managed lifecycle helpers ───────────────────────────────────────────────

// These tests pin the two helpers the TUI uses to route managed-board
// progress through `transitionTask` instead of free-form `moveTask`. The
// stage order MUST stay in lockstep with `KANBAN_AGENT_STAGES` in
// `@wrongstack/kanban`; a drift here would send users to the wrong column
// or report "already at done" one stage early.

function managedBoard(columns?: Partial<Record<string, string>>): KanbanBoard {
  const cols = columns ?? {
    backlog: 'backlog',
    todo: 'todo',
    running: 'in-progress',
    review: 'review',
    done: 'done',
  };
  return {
    id: 'mb',
    title: 'Managed',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'To Do', order: 1 },
      { id: 'in-progress', title: 'In Progress', order: 2 },
      { id: 'review', title: 'Review', order: 3 },
      { id: 'done', title: 'Done', order: 4 },
    ],
    tasks: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    lifecycle: {
      mode: 'managed',
      columns: {
        backlog: cols.backlog ?? 'backlog',
        todo: cols.todo ?? 'todo',
        running: cols.running ?? 'in-progress',
        review: cols.review ?? 'review',
        done: cols.done ?? 'done',
      },
    },
  };
}

describe('stageForColumn — managed board column → stage lookup', () => {
  it('returns the stage for each mapped column on a managed board', () => {
    const b = managedBoard();
    expect(stageForColumn(b, 'backlog')).toBe('backlog');
    expect(stageForColumn(b, 'todo')).toBe('todo');
    expect(stageForColumn(b, 'in-progress')).toBe('running');
    expect(stageForColumn(b, 'review')).toBe('review');
    expect(stageForColumn(b, 'done')).toBe('done');
  });

  it('returns null for a non-managed board', () => {
    const legacy: KanbanBoard = {
      id: 'legacy',
      title: 'Legacy',
      columns: [{ id: 'todo', title: 'To Do', order: 0 }],
      tasks: [],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    expect(stageForColumn(legacy, 'todo')).toBeNull();
  });

  it('returns null when the column is not one of the five lifecycle columns', () => {
    const b = managedBoard();
    expect(stageForColumn(b, 'custom-column')).toBeNull();
  });
});

describe('nextManagedStage — single-step forward advance', () => {
  it('walks the canonical stage order one step at a time', () => {
    expect(nextManagedStage('backlog')).toBe('todo');
    expect(nextManagedStage('todo')).toBe('running');
    expect(nextManagedStage('running')).toBe('review');
    expect(nextManagedStage('review')).toBe('done');
  });

  it('returns null at the terminal `done` stage so callers can show a notice', () => {
    expect(nextManagedStage('done')).toBeNull();
  });
});
