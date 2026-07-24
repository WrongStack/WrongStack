import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addTask, createBoard, getBoard } from '../src/manager.js';
import {
  proposeTaskDecomposition,
  resolveDecompositionProposal,
} from '../src/manager/decomposition.js';
import { readKanbanEvents } from '../src/storage.js';
import type { KanbanDecompositionSubtask } from '../src/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-decomp-'));
});

const SUBTASKS: KanbanDecompositionSubtask[] = [
  {
    title: 'Add login endpoint',
    description: 'POST /login with session cookie',
    successCriteria: ['verify: pnpm vitest run login'],
  },
  {
    title: 'Add signup endpoint',
    description: 'POST /signup',
    successCriteria: ['signup persists a user'],
    dependsOnIndex: [0],
  },
];

async function seed(decompositionMode: 'auto' | 'propose') {
  const board = await createBoard(tmpDir, {
    title: 'Decomp board',
    atomicity: { mode: 'assess', decomposition: decompositionMode },
  });
  const added = await addTask(tmpDir, board.id, {
    title: 'Build auth',
    description: 'Everything auth-related',
  });
  return { boardId: board.id, taskId: added!.task.id };
}

describe('proposeTaskDecomposition', () => {
  it('rejects fewer than two subtasks', async () => {
    const { boardId, taskId } = await seed('propose');
    await expect(
      proposeTaskDecomposition(tmpDir, boardId, taskId, {
        subtasks: [SUBTASKS[0]!],
      }),
    ).rejects.toThrow(/at least two/);
  });

  it('propose mode parks the proposal on the task and emits an event', async () => {
    const { boardId, taskId } = await seed('propose');
    const result = await proposeTaskDecomposition(tmpDir, boardId, taskId, {
      subtasks: SUBTASKS,
      rationale: 'too big',
      proposedBy: 'agent-1',
    });
    expect(result?.proposal.status).toBe('proposed');
    expect(result?.proposal.mode).toBe('approval');
    expect(result?.task.decomposition?.proposedSubtasks).toHaveLength(2);
    // No children created yet.
    expect(result?.board.tasks).toHaveLength(1);

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.decomposition.proposed')).toBe(true);
  });

  it('auto mode applies immediately: children, atomic parent, criteria mapping', async () => {
    const { boardId, taskId } = await seed('auto');
    const result = await proposeTaskDecomposition(tmpDir, boardId, taskId, {
      subtasks: SUBTASKS,
    });
    expect(result?.proposal.status).toBe('applied');
    expect(result?.proposal.appliedChildTaskIds).toHaveLength(2);

    const board = await getBoard(tmpDir, boardId);
    const parent = board!.tasks.find((task) => task.id === taskId)!;
    expect(parent.atomic).toBe(true);
    expect(parent.childTaskIds).toHaveLength(2);
    expect(parent.atomicityAssessment?.verdict).toBe('composite');

    const [loginId, signupId] = result!.proposal.appliedChildTaskIds!;
    const login = board!.tasks.find((task) => task.id === loginId)!;
    const signup = board!.tasks.find((task) => task.id === signupId)!;
    // Command-marked criterion → deterministic check type; free text → manual.
    expect(login.successCriteria?.[0]).toMatchObject({ type: 'command', status: 'pending' });
    expect(signup.successCriteria?.[0]).toMatchObject({ type: 'manual', status: 'pending' });
    expect(login.description).toBe('POST /login with session cookie');
    // dependsOnIndex wired to real child ids.
    expect(signup.dependsOn).toEqual([loginId]);

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.decomposition.applied')).toBe(true);
    expect(events.some((event) => event.type === 'task.split')).toBe(true);
  });
});

describe('resolveDecompositionProposal', () => {
  it('approve applies the split (with optional edits)', async () => {
    const { boardId, taskId } = await seed('propose');
    const proposed = await proposeTaskDecomposition(tmpDir, boardId, taskId, {
      subtasks: SUBTASKS,
    });
    const resolved = await resolveDecompositionProposal(
      tmpDir,
      boardId,
      taskId,
      proposed!.proposal.id,
      {
        action: 'approve',
        resolvedBy: 'reviewer',
        editedSubtasks: [
          { title: 'Only login', description: 'narrowed' },
          { title: 'Only signup', description: 'narrowed 2' },
        ],
      },
    );
    expect(resolved?.proposal.status).toBe('applied');
    const board = await getBoard(tmpDir, boardId);
    const childTitles = board!.tasks
      .filter((task) => task.parentTaskId === taskId)
      .map((task) => task.title)
      .sort();
    expect(childTitles).toEqual(['Only login', 'Only signup']);
  });

  it('reject records resolution without creating children', async () => {
    const { boardId, taskId } = await seed('propose');
    const proposed = await proposeTaskDecomposition(tmpDir, boardId, taskId, {
      subtasks: SUBTASKS,
    });
    const resolved = await resolveDecompositionProposal(
      tmpDir,
      boardId,
      taskId,
      proposed!.proposal.id,
      { action: 'reject', reason: 'not needed', resolvedBy: 'reviewer' },
    );
    expect(resolved?.proposal.status).toBe('rejected');
    expect(resolved?.proposal.resolutionReason).toBe('not needed');
    expect(resolved?.board.tasks).toHaveLength(1);

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.decomposition.rejected')).toBe(true);
  });

  it('returns null for unknown/already-resolved proposals', async () => {
    const { boardId, taskId } = await seed('propose');
    const proposed = await proposeTaskDecomposition(tmpDir, boardId, taskId, {
      subtasks: SUBTASKS,
    });
    expect(
      await resolveDecompositionProposal(tmpDir, boardId, taskId, 'wrong-id', {
        action: 'approve',
      }),
    ).toBeNull();
    await resolveDecompositionProposal(tmpDir, boardId, taskId, proposed!.proposal.id, {
      action: 'reject',
    });
    expect(
      await resolveDecompositionProposal(tmpDir, boardId, taskId, proposed!.proposal.id, {
        action: 'approve',
      }),
    ).toBeNull();
  });
});
