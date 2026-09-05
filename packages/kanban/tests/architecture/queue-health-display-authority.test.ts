import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * `KanbanQueueHealth.counts.ready` tallies the stored `status` field. No
 * production dispatcher ever writes `status: 'ready'`, so on a real board it is
 * structurally 0 — while `counts.startable` holds the number the board would
 * actually hand out. The field stays (three tests seed `status: 'ready'`
 * directly and assert it), but four separate display surfaces rendered it and
 * each showed a permanent zero next to a board with claimable work.
 *
 * This guard keeps `ready` a diagnostic. Every read of it in a display surface
 * must be listed below with the reason it is legitimate; anything else is the
 * bug coming back.
 */

/** Files that render queue health to a human. */
const DISPLAY_SURFACES = [
  'packages/tui/src/kanban-slash.ts',
  'packages/webui/src/components/KanbanQueueHealthBar.tsx',
  'packages/webui-hq/src/domain/kanban-queue-health.ts',
  'packages/webui-hq/src/views/kanban/queue-health.tsx',
  'packages/webui-server/src/server/kanban-board-routes.ts',
  'packages/webui-server/src/server/kanban-routes.ts',
  'packages/webui-server/src/server/kanban-supervisor.ts',
  'packages/tools/src/kanban.ts',
];

/**
 * Reads of the diagnostic field that are correct as written.
 *
 * `kanban-slash.ts` sums the raw status partition to decide whether a board has
 * any lifecycle-tracked cards at all. Every card lands in exactly one bucket
 * there, so dropping `ready` would under-count and substituting `startable`
 * would double-count (a startable card is already in `pending`).
 */
const ALLOWED_READS: ReadonlyArray<{ file: string; fragment: string }> = [
  {
    file: 'packages/tui/src/kanban-slash.ts',
    fragment: 'c.pending + c.ready + c.running',
  },
];

/** Strips line and block comments so prose about `counts.ready` is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '');
}

describe('queue health display authority', () => {
  it('keeps counts.ready out of display surfaces', () => {
    const offenders: string[] = [];
    for (const file of DISPLAY_SURFACES) {
      const lines = stripComments(read(file)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/\bcounts\.ready\b|\bc\.ready\b|\bhealth\.ready\b/.test(line)) return;
        const allowed = ALLOWED_READS.some(
          (entry) => entry.file === file && line.includes(entry.fragment),
        );
        if (!allowed) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('documents ready as diagnostic-only on the type', () => {
    const types = read('packages/kanban/src/types-operations.ts');
    expect(types).toContain('startable');
    // The doc comment is the reason a reader picks `startable`; if it goes, the
    // next surface picks `ready` again.
    expect(types).toMatch(/ready[\s\S]{0,400}startable/);
  });

  it('renders the startable count on every surface that shows claimable work', () => {
    // Assembled so the literal is not itself a template placeholder.
    expect(read('packages/tui/src/kanban-slash.ts')).toContain(`startable $\{c.startable}`);
    expect(read('packages/webui/src/components/KanbanQueueHealthBar.tsx')).toContain(
      'queueHealth.counts.startable',
    );
    expect(read('packages/webui-server/src/server/kanban-supervisor.ts')).toContain(
      'counts.startable',
    );
    expect(read('packages/webui-hq/src/views/kanban/queue-health.tsx')).toContain(
      'counts.startable',
    );
  });

  it('counts queue anomalies through the one shared helper', () => {
    // Three surfaces each had their own union of health signals, so the same
    // board could be "healthy" in one pane and "attention" in another.
    for (const file of [
      'packages/webui-server/src/server/kanban-board-routes.ts',
      'packages/webui-server/src/server/kanban-supervisor.ts',
    ]) {
      expect(read(file)).toContain('kanbanQueueAnomalyCount');
    }
    expect(read('packages/webui/src/components/KanbanQueueHealthBar.tsx')).toContain(
      'hasKanbanQueueAnomalies',
    );
  });
});
