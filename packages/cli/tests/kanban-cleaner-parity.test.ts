/**
 * The Kanban Cleaner has two implementations: `packages/tui/src/kanban-audit.ts`
 * and `packages/webui/src/lib/kanban-cleaner.ts`. Both file headers claimed they
 * stayed "in lock-step"; when the claim was actually checked, they disagreed on
 * more than a dozen boards — whether a managed card needs a label, whether a
 * half-written lease counts as abandoned, whether `['  ']` is a label at all.
 * A user auditing the same board from the TUI and the WebUI got different lists.
 *
 * This test is what the header comments now point at. It runs a shared corpus
 * through both and compares the `taskId:code:severity` triples.
 *
 * MESSAGES ARE NOT COMPARED. Both surfaces are free to word a finding for their
 * own audience; only the verdict has to agree.
 *
 * Deliberate divergences, all of them API shape rather than verdict:
 *   - the TUI copy accepts `liveAgentIdentities` (the WebUI deprecated it: its
 *     roster only sees the connected session, so a cross-session agent looked
 *     dead). The corpus never passes it, so both run the same path.
 *   - the TUI summary carries eight extra fields the WebUI's `KanbanCleanerAlert`
 *     fills from live queue health instead.
 *   - `summarizeAuditHeadline` / `topAuditIssues` are TUI-only.
 *
 * Lives in `packages/cli/tests` because `@wrongstack/cli` is the one package
 * that depends on both. The imports are relative to source, not to `dist`, so a
 * stale build cannot hide a divergence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KanbanAgentAssignment, KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { KANBAN_BOARD_SOFT_MAX_BYTES } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  auditKanbanBoard as auditTui,
  ALL_AUDIT_CODES as TUI_CODES,
} from '../../tui/src/kanban-audit.js';
import {
  auditKanbanBoard as auditWebui,
  ALL_AUDIT_CODES as WEBUI_CODES,
} from '../../webui/src/lib/kanban-cleaner.js';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const STALE_REVIEW_AT = '2026-07-15T06:00:00.000Z'; // 78h before NOW, past the 72h default

function task(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    description: 'A described task.',
    labels: ['area:core'],
    childTaskIds: ['child-1'],
    successCriteria: [{ id: 'c', description: 'Ships', type: 'manual', status: 'pending' }],
    assignedAgent: 'core-builder',
    ...overrides,
  } as KanbanTask;
}

function board(tasks: KanbanTask[], overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'b-parity',
    title: 'Parity corpus',
    columns: [
      { id: 'todo', title: 'To Do', order: 0 },
      { id: 'review', title: 'Review', order: 1 },
    ],
    tasks,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    version: 1,
    ...overrides,
  } as KanbanBoard;
}

function managed(tasks: KanbanTask[]): KanbanBoard {
  return board(tasks, {
    lifecycle: {
      mode: 'managed',
      columns: {
        backlog: 'todo',
        todo: 'todo',
        running: 'todo',
        review: 'review',
        done: 'review',
      },
    },
  } as Partial<KanbanBoard>);
}

function assignment(overrides: Record<string, unknown> = {}): KanbanAgentAssignment {
  return {
    status: 'running',
    agentId: 'agent-1',
    leaseId: 'lease-1',
    claimedAt: NOW_ISO,
    heartbeatAt: NOW_ISO,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  } as KanbanAgentAssignment;
}

/** A board serialized well past the soft ceiling, without 500 KB of literals. */
function oversizedBoard(): KanbanBoard {
  const filler = 'x'.repeat(4096);
  return board(
    Array.from({ length: 200 }, (_, index) =>
      task(`bulk-${index}`, { description: `${filler}-${index}` }),
    ),
  );
}

interface Case {
  label: string;
  board: KanbanBoard;
  requireDueDate?: boolean;
}

const CORPUS: Case[] = [
  // ── One case per code ─────────────────────────────────────────────────
  { label: 'clean legacy card', board: board([task('clean')]) },
  {
    label: 'missing description',
    board: board([task('no-desc', { description: '   ' })]),
  },
  {
    label: 'missing assignee',
    board: board([task('no-owner', { assignedAgent: undefined, assignee: undefined })]),
  },
  {
    label: 'missing due date when the caller asks for one',
    board: board([task('no-due')]),
    requireDueDate: true,
  },
  {
    label: 'missing labels and tags',
    board: board([task('no-labels', { labels: [] })]),
  },
  {
    label: 'missing subtasks',
    board: board([task('no-children', { childTaskIds: [] })]),
  },
  {
    label: 'missing success criteria',
    board: board([task('no-criteria', { successCriteria: [] })]),
  },
  {
    label: 'running without a lease',
    board: board([task('abandoned', { status: 'in_progress' })]),
  },
  {
    label: 'running with an expired lease',
    board: board([
      task('expired', {
        status: 'in_progress',
        assignment: assignment({ leaseExpiresAt: '2026-07-18T11:00:00.000Z' }),
      }),
    ]),
  },
  {
    label: 'stale review',
    board: board([task('stale', { status: 'review', updatedAt: STALE_REVIEW_AT })]),
  },
  {
    label: 'skipped lifecycle state',
    board: managed([
      task('skipper', {
        lifecycle: {
          currentStage: 'review',
          history: [
            { to: 'backlog', at: NOW_ISO },
            { to: 'review', at: NOW_ISO },
          ],
        },
      } as Partial<KanbanTask>),
    ]),
  },
  { label: 'oversized board', board: oversizedBoard() },

  // ── Divergence axes ───────────────────────────────────────────────────
  {
    label: 'managed board does not demand a due date on its own',
    board: managed([task('managed-no-due')]),
  },
  {
    label: 'managed board honors an explicit requireDueDate: false',
    board: managed([task('managed-opt-out')]),
    requireDueDate: false,
  },
  {
    label: 'due date stored as epoch millis',
    board: board([
      task('epoch-due', { dueDate: 1_784_000_000_000 } as unknown as Partial<KanbanTask>),
    ]),
    requireDueDate: true,
  },
  {
    label: 'due date stored as a Date',
    board: board([task('date-due', { dueDate: new Date(NOW) } as unknown as Partial<KanbanTask>)]),
    requireDueDate: true,
  },
  {
    label: 'due date that is a non-empty but unparseable string',
    board: board([task('garbage-due', { dueDate: 'soonish' })]),
    requireDueDate: true,
  },
  {
    label: 'labels present but blank',
    board: board([task('blank-labels', { labels: ['  ', ''] })]),
  },
  {
    label: 'tags substituting for labels on a legacy board',
    board: board([task('tags-only', { labels: [], tags: ['ops'] } as Partial<KanbanTask>)]),
  },
  {
    label: 'tags do not substitute for labels on a managed board',
    board: managed([
      task('managed-tags-only', { labels: [], tags: ['ops'] } as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'legacy subtask objects substituting for childTaskIds',
    board: board([
      task('subtask-objects', {
        childTaskIds: [],
        subtasks: [{ title: 'Wire it up' }],
      } as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'subtask objects carrying nothing identifying',
    board: board([
      task('subtask-empty', { childTaskIds: [], subtasks: [{}] } as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'string success criteria on a legacy board',
    board: board([
      task('string-criteria', { successCriteria: ['Ships'] } as unknown as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'string success criteria on a managed board',
    board: managed([
      task('managed-string-criteria', {
        successCriteria: ['Ships'],
      } as unknown as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'success criteria object with a blank description',
    board: board([
      task('blank-criteria', { successCriteria: [{ description: '  ' }] } as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'assigned by subagentId alone, legacy board',
    board: board([
      task('subagent-only', {
        assignedAgent: undefined,
        assignment: assignment({ status: 'queued', agentId: undefined, subagentId: 'sub-9' }),
      }),
    ]),
  },
  {
    label: 'assigned by subagentId alone, managed board',
    board: managed([
      task('managed-subagent-only', {
        assignedAgent: undefined,
        assignment: assignment({ status: 'queued', agentId: undefined, subagentId: 'sub-9' }),
      }),
    ]),
  },
  {
    label: 'lease missing claimedAt',
    board: board([
      task('no-claimed', {
        status: 'in_progress',
        assignment: assignment({ claimedAt: undefined }),
      }),
    ]),
  },
  {
    label: 'lease missing heartbeatAt',
    board: board([
      task('no-heartbeat', {
        status: 'in_progress',
        assignment: assignment({ heartbeatAt: undefined }),
      }),
    ]),
  },
  {
    label: 'lease missing leaseId',
    board: board([
      task('no-lease-id', {
        status: 'in_progress',
        assignment: assignment({ leaseId: undefined }),
      }),
    ]),
  },
  {
    label: 'complete lease, live',
    board: board([task('healthy-running', { status: 'in_progress', assignment: assignment() })]),
  },
  {
    label: 'assignment says running while the status does not',
    board: board([task('assignment-running', { assignment: assignment() })]),
  },
  {
    label: 'completed card with a skipped lifecycle history',
    board: managed([
      task('done-skipper', {
        status: 'completed',
        lifecycle: {
          currentStage: 'done',
          history: [
            { to: 'backlog', at: NOW_ISO },
            { to: 'done', at: NOW_ISO },
          ],
        },
      } as Partial<KanbanTask>),
    ]),
  },
  {
    label: 'archived card missing every detail',
    board: board([
      task('archived-empty', {
        status: 'archived',
        description: '',
        labels: [],
        childTaskIds: [],
        successCriteria: [],
        assignedAgent: undefined,
      }),
    ]),
  },
  {
    label: 'managed board with renamed columns still resolves canonical stages',
    board: board(
      [
        task('renamed', {
          lifecycle: {
            currentStage: 'review',
            history: [
              { to: 'backlog', at: NOW_ISO },
              { to: 'review', at: NOW_ISO },
            ],
          },
        } as Partial<KanbanTask>),
      ],
      {
        lifecycle: {
          mode: 'managed',
          columns: {
            backlog: 'Icebox',
            todo: 'Next',
            running: 'Doing',
            review: 'QA',
            done: 'Shipped',
          },
        },
      } as Partial<KanbanBoard>,
    ),
  },
  {
    label: 'board with several cards at once',
    board: managed([
      task('multi-clean'),
      task('multi-no-desc', { description: '' }),
      task('multi-stale-review', { status: 'review', updatedAt: STALE_REVIEW_AT }),
      task('multi-abandoned', { status: 'in_progress' }),
    ]),
  },
];

/** Verdict fingerprint: task, code and severity — never the message. */
function verdicts(
  issues: ReadonlyArray<{ taskId: string; code: string; severity: string }>,
): string[] {
  return issues.map((issue) => `${issue.taskId}:${issue.code}:${issue.severity}`).sort();
}

describe('Kanban Cleaner parity', () => {
  it.each(CORPUS)('agrees on "$label"', ({ board: subject, requireDueDate }) => {
    const options = {
      now: NOW,
      ...(requireDueDate === undefined ? {} : { requireDueDate }),
    };
    const tui = auditTui(subject, options);
    const webui = auditWebui(subject, options);

    expect(verdicts(webui.issues)).toEqual(verdicts(tui.issues));
    expect(webui.counts).toEqual(tui.counts);
    expect(webui.affectedTaskCount).toBe(tui.affectedTaskCount);
  });

  it('shares one audit vocabulary', () => {
    expect([...WEBUI_CODES]).toEqual([...TUI_CODES]);
  });

  it('only ever emits codes from that vocabulary', () => {
    const vocabulary = new Set<string>(TUI_CODES);
    const emitted = new Set<string>();
    for (const { board: subject, requireDueDate } of CORPUS) {
      const options = {
        now: NOW,
        ...(requireDueDate === undefined ? {} : { requireDueDate }),
      };
      for (const audit of [auditTui(subject, options), auditWebui(subject, options)]) {
        for (const issue of audit.issues) emitted.add(issue.code);
      }
    }
    expect([...emitted].filter((code) => !vocabulary.has(code))).toEqual([]);
    // A code nothing can produce is a code nobody maintains. Every entry in the
    // vocabulary has a corpus case above; if this fails, the corpus lost one.
    expect([...vocabulary].filter((code) => !emitted.has(code)).sort()).toEqual([]);
  });

  it('pins both inlined size thresholds to the storage constant', () => {
    // Neither cleaner can import the constant: the WebUI half would drag
    // `node:net` into the browser bundle through the package barrel. So both
    // inline `512 * 1024`, and this is what keeps the copies honest.
    const sources = [
      'packages/tui/src/kanban-audit.ts',
      'packages/webui/src/lib/kanban-cleaner.ts',
    ];
    expect(KANBAN_BOARD_SOFT_MAX_BYTES).toBe(512 * 1024);
    for (const relativePath of sources) {
      const source = readRepoFile(relativePath);
      expect(source, relativePath).toContain('const BOARD_SOFT_MAX_BYTES = 512 * 1024;');
    }
  });

  it('names this test from both implementations', () => {
    for (const relativePath of [
      'packages/tui/src/kanban-audit.ts',
      'packages/webui/src/lib/kanban-cleaner.ts',
    ]) {
      expect(readRepoFile(relativePath), relativePath).toContain('kanban-cleaner-parity.test.ts');
    }
  });
});

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '../../..', relativePath), 'utf8');
}
