import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listBoards } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  buildTaskGraphFromAutophasePhase,
  buildTaskGraphFromSddSnapshot,
  createKanbanRunMirror,
} from '../src/webui-server/kanban-run-mirror.js';

const settle = () => new Promise((r) => setTimeout(r, 500)); // > DEBOUNCE_MS (300)

function autophaseState(over: { statusA?: string } = {}) {
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture cast to the SDD type
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
    const n2 = (g.nodes as Array<Record<string, unknown>>)[1];
    expect(n2.assignee).toBe('Curie');
    expect(n2.status).toBe('in_progress');
    expect(n2.metadata).toMatchObject({
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

describe('buildTaskGraphFromAutophasePhase', () => {
  it('stamps the RUN graphId and tags nodes with the phase name', () => {
    const g = buildTaskGraphFromAutophasePhase('graph1', 'My run', {
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
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any);
    expect(g.id).toBe('graph1'); // run graphId, NOT phase id
    expect((g.nodes as Array<{ id: string }>).length).toBe(1);
    const n = (g.nodes as Array<Record<string, unknown>>)[0];
    expect(n.tags).toEqual(['Design']);
    expect(n.assignee).toBe('Bohr');
    expect(n.status).toBe('in_progress');
  });
});

describe('KanbanRunMirror AutoPhase → one board per phase', () => {
  it('creates a separate board per phase, grouped by run tag', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mirror-ap-'));
    const mirror = createKanbanRunMirror({ projectRoot: dir, broadcast: () => {}, log: () => {} });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: loose buildState() fixture
      mirror.onAutophaseState('g-run', autophaseState() as any);
      await settle();

      const ap = (await listBoards(dir)).filter((b) => b.tags?.includes('autophase'));
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
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      m1.onAutophaseState('g-run', autophaseState() as any);
      await settle();
      const first = (await listBoards(dir)).length;
      m1.dispose();

      // Fresh mirror (empty in-memory map), same dir, a CHANGED state (new stamp
      // so it actually re-projects) → must reclaim the 2 boards via disk scan.
      const m2 = createKanbanRunMirror({ projectRoot: dir, broadcast: () => {}, log: () => {} });
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      m2.onAutophaseState('g-run', autophaseState({ statusA: 'in_progress' }) as any);
      await settle();
      expect((await listBoards(dir)).length).toBe(first); // reclaimed, not duplicated
      m2.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
