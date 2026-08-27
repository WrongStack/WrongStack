import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listBoards } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  buildTaskGraphFromGoalPhase,
  buildTaskGraphFromSddSnapshot,
  createKanbanRunMirror,
} from '../src/webui-server/kanban-run-mirror.js';

const settle = () => new Promise((r) => setTimeout(r, 500)); // > DEBOUNCE_MS (300)

function goalState(over: { statusA?: string } = {}) {
  return {
    title: 'Feature X',
    phases: [
      {
        id: 'p1',
        name: 'Design',
        tasks: [
          {
            id: 'a',
            title: 'A',
            status: over.statusA ?? 'pending',
            priority: 'medium',
            type: 'feature',
          },
        ],
      },
      {
        id: 'p2',
        name: 'Build',
        tasks: [{ id: 'b', title: 'B', status: 'pending', priority: 'medium', type: 'feature' }],
      },
    ],
  };
}

// Minimal SddBoardTask factory (only the fields the normalizer reads).
function sddTask(over: Record<string, unknown>) {
  return {
    id: 'n',
    shortId: 't00',
    title: 'task',
    description: '',
    status: 'pending',
    displayStatus: 'pending',
    priority: 'medium',
    type: 'feature',
    deps: [],
    retries: 0,
    ...over,
  };
}

function snapshot(tasks: Array<Record<string, unknown>>) {
  return {
    runId: 'sdd-1',
    graphId: 'g1',
    specId: 's1',
    title: 'Run',
    status: 'running',
    startedAt: 0,
    updatedAt: 1,
    progress: {},
    wave: 1,
    tasks,
    columns: [],
  } as any;
}

describe('buildTaskGraphFromSddSnapshot', () => {
  it('keys nodes by real id, resolves shortId deps, carries runtime in metadata', () => {
    const g = buildTaskGraphFromSddSnapshot(
      snapshot([
        sddTask({ id: 'n1', shortId: 't01' }),
        sddTask({
          id: 'n2',
          shortId: 't02',
          deps: ['t01'],
          agentName: 'Curie',
          model: 'gpt-x',
          provider: 'openai',
          fallbackModels: ['m2'],
          worktreeBranch: 'wt/x',
          retries: 2,
          status: 'in_progress',
          displayStatus: 'in_progress',
        }),
      ]),
    );
    expect(g.id).toBe('g1');
    expect(g.specId).toBe('s1');
    expect((g.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(g.edges).toEqual([{ id: 'n1->n2', from: 'n1', to: 'n2', type: 'depends_on' }]);
    expect(g.rootNodes).toEqual(['n1']);
    const n2 = (g.nodes as unknown as Array<Record<string, unknown>>)[1];
    expect(n2?.assignee).toBe('Curie');
    expect(n2?.status).toBe('in_progress');
    expect(n2?.metadata).toMatchObject({
      model: 'gpt-x',
      provider: 'openai',
      fallbackModels: ['m2'],
      worktreeBranch: 'wt/x',
      retries: 2,
    });
  });

  it('drops deps whose shortId is unknown and falls back rootNodes to first node', () => {
    const g = buildTaskGraphFromSddSnapshot(
      snapshot([sddTask({ id: 'n1', shortId: 't01', deps: ['tZZ'] })]),
    );
    expect(g.edges).toEqual([]);
    expect(g.rootNodes).toEqual(['n1']);
  });
});

describe('buildTaskGraphFromGoalPhase', () => {
  it('stamps the RUN graphId and tags nodes with the phase name', () => {
    const g = buildTaskGraphFromGoalPhase('graph1', 'My run', {
      id: 'phase-a',
      name: 'Design',
      tasks: [
        {
          id: 'p1',
          title: 'T1',
          status: 'in_progress',
          priority: 'high',
          type: 'feature',
          assignee: 'Bohr',
        },
      ],
    } as any);
    expect(g.id).toBe('graph1'); // run graphId, NOT phase id
    expect((g.nodes as Array<{ id: string }>).length).toBe(1);
    const n = (g.nodes as unknown as Array<Record<string, unknown>>)[0];
    expect(n?.tags).toEqual(['Design']);
    expect(n?.assignee).toBe('Bohr');
    expect(n?.status).toBe('in_progress');
  });
});

describe('KanbanRunMirror SDD → one board per topo wave', () => {
  it('creates a separate board per dependency column when columns > 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-sdd-waves-'));
    function fakeEvents() {
      const handlers = new Map<string, Array<(p: unknown) => void>>();
      return {
        on(name: string, fn: (p: unknown) => void) {
          const list = handlers.get(name) ?? [];
          list.push(fn);
          handlers.set(name, list);
          return () => {};
        },
        emit(name: string, payload: unknown) {
          for (const fn of handlers.get(name) ?? []) fn(payload);
        },
      };
    }
    const events = fakeEvents();
    const mirror = createKanbanRunMirror({
      projectRoot: dir,
      events: events as never,
      broadcast: () => {},
      log: () => {},
    });
    try {
      events.emit('sdd.board.snapshot', {
        runId: 'sdd-wave',
        snapshot: {
          runId: 'sdd-wave',
          graphId: 'g-wave',
          title: 'Multi-wave',
          status: 'running',
          startedAt: 0,
          updatedAt: 1,
          progress: {},
          wave: 0,
          tasks: [
            sddTask({ id: 'n1', shortId: 't01', title: 'Root A' }),
            sddTask({ id: 'n2', shortId: 't02', title: 'Root B' }),
            sddTask({ id: 'n3', shortId: 't03', title: 'Child', deps: ['t01'] }),
          ],
          columns: [
            { label: 'Wave 1', taskIds: ['t01', 't02'] },
            { label: 'Wave 2', taskIds: ['t03'] },
          ],
        },
      });
      await settle();
      const boards = (await listBoards(dir)).filter((b) => b.tags?.includes('sdd'));
      expect(boards.length).toBe(2);
      expect(boards.every((b) => b.tags?.includes('run:sdd-wave'))).toBe(true);
      expect(boards.map((b) => b.tags?.find((t) => t.startsWith('phase:'))).sort()).toEqual([
        'phase:wave-0',
        'phase:wave-1',
      ]);
      expect(boards.every((b) => b.title.startsWith('Multi-wave — '))).toBe(true);
    } finally {
      mirror.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('KanbanRunMirror Goal → one board per phase', () => {
  it('creates a separate board per phase, grouped by run tag', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-ap-'));
    const mirror = createKanbanRunMirror({ projectRoot: dir, broadcast: () => {}, log: () => {} });
    try {
      mirror.onGoalState('g-run', goalState() as any);
      await settle();

      const ap = (await listBoards(dir)).filter((b) => b.tags?.includes('goal'));
      expect(ap.length).toBe(2); // one board PER PHASE, not one crowded board
      // All phase boards group under the same run.
      expect(ap.every((b) => b.tags?.includes('run:g-run'))).toBe(true);
      // Each carries its own phase tag + a "<run> — <phase>" title.
      expect(ap.map((b) => b.tags?.find((t) => t.startsWith('phase:'))).sort()).toEqual([
        'phase:p1',
        'phase:p2',
      ]);
      expect(ap.every((b) => b.title.startsWith('Feature X — '))).toBe(true);
    } finally {
      mirror.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims existing phase boards across a mirror restart (no duplicates)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-ap2-'));
    const m1 = createKanbanRunMirror({ projectRoot: dir, broadcast: () => {}, log: () => {} });
    try {
      m1.onGoalState('g-run', goalState() as any);
      await settle();
      const first = (await listBoards(dir)).length;
      m1.dispose();

      // Fresh mirror (empty in-memory map), same dir, a CHANGED state (new stamp
      // so it actually re-projects) → must reclaim the 2 boards via disk scan.
      const m2 = createKanbanRunMirror({ projectRoot: dir, broadcast: () => {}, log: () => {} });
      m2.onGoalState('g-run', goalState({ statusA: 'in_progress' }) as any);
      await settle();
      expect((await listBoards(dir)).length).toBe(first); // reclaimed, not duplicated
      m2.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('KanbanRunMirror SDD verification + field preservation', () => {
  function fakeEvents() {
    const handlers = new Map<string, Array<(p: unknown) => void>>();
    return {
      on(name: string, fn: (p: unknown) => void) {
        const list = handlers.get(name) ?? [];
        list.push(fn);
        handlers.set(name, list);
        return () => {};
      },
      emit(name: string, payload: unknown) {
        for (const fn of handlers.get(name) ?? []) fn(payload);
      },
    };
  }

  it('maps run verification into a minimal report and preserves kanban-local fields across sync ticks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-verify-'));
    const events = fakeEvents();
    const mirror = createKanbanRunMirror({
      projectRoot: dir,
      events: events as never,
      broadcast: () => {},
      log: () => {},
    });
    try {
      // Tick 1: one completed task whose run verification passed.
      events.emit('sdd.board.snapshot', {
        runId: 'sdd-v1',
        snapshot: snapshot([
          sddTask({
            id: 'n1',
            shortId: 't01',
            title: 'Verified work',
            status: 'completed',
            displayStatus: 'completed',
            completedAt: 100,
            verificationCommand: 'pnpm test x',
            verificationState: 'passed',
          }),
        ]),
      });
      await settle();

      const { getBoard, listBoards: list } = await import('@wrongstack/kanban');
      const { updateTask } = await import('@wrongstack/kanban/test-support');
      const summary = (await list(dir)).find((b) => b.tags?.includes('run:sdd-v1'));
      expect(summary).toBeDefined();
      let board = await getBoard(dir, summary!.id);
      // Mirror boards are created with the completion gate off.
      expect(board!.completionGate?.enforcement).toBe('off');
      const mirrored = board!.tasks.find((t) => t.origin?.taskId === 'n1');
      expect(mirrored?.verificationReport?.verdict).toBe('passed');
      expect(mirrored?.status).toBe('completed');

      // Seed kanban-local fields the sync must never clobber.
      await updateTask(dir, board!.id, mirrored!.id, {
        atomic: true,
        decomposition: {
          id: 'prop-x',
          taskId: mirrored!.id,
          status: 'proposed',
          mode: 'approval',
          proposedSubtasks: [
            { title: 'A', description: 'a' },
            { title: 'B', description: 'b' },
          ],
          proposedAt: new Date().toISOString(),
        },
      });

      // Tick 2: changed snapshot (new stamp) re-syncs the same graph.
      events.emit('sdd.board.snapshot', {
        runId: 'sdd-v1',
        snapshot: snapshot([
          sddTask({
            id: 'n1',
            shortId: 't01',
            title: 'Verified work',
            status: 'completed',
            displayStatus: 'completed',
            completedAt: 200,
            verificationCommand: 'pnpm test x',
            verificationState: 'passed',
          }),
        ]),
      });
      await settle();

      board = await getBoard(dir, summary!.id);
      const after = board!.tasks.find((t) => t.origin?.taskId === 'n1');
      // One-directional rule: kanban-local fields survive sync ticks.
      expect(after?.atomic).toBe(true);
      expect(after?.decomposition?.status).toBe('proposed');
      expect(after?.verificationReport?.verdict).toBe('passed');
    } finally {
      mirror.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('maps a failed run verification into a failed report with the reason', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-vfail-'));
    const events = fakeEvents();
    const mirror = createKanbanRunMirror({
      projectRoot: dir,
      events: events as never,
      broadcast: () => {},
      log: () => {},
    });
    try {
      events.emit('sdd.board.snapshot', {
        runId: 'sdd-v2',
        snapshot: snapshot([
          sddTask({
            id: 'n1',
            shortId: 't01',
            title: 'Rejected work',
            status: 'failed',
            displayStatus: 'failed',
            verificationState: 'failed',
            verificationDetail: 'verification failed: exit 1',
          }),
        ]),
      });
      await settle();

      const { getBoard, listBoards: list } = await import('@wrongstack/kanban');
      const summary = (await list(dir)).find((b) => b.tags?.includes('run:sdd-v2'));
      const board = await getBoard(dir, summary!.id);
      const mirrored = board!.tasks.find((t) => t.origin?.taskId === 'n1');
      expect(mirrored?.verificationReport?.verdict).toBe('failed');
      expect(mirrored?.verificationReport?.checks[0]?.error).toContain('exit 1');
    } finally {
      mirror.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
