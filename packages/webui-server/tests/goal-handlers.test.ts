import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockUpdateGoal = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/goal', async (importOriginal) => ({
  ...(await importOriginal()),
  updateGoal: mockUpdateGoal,
}));

const mockResolveWstackPaths = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/core/utils', () => ({
  resolveWstackPaths: mockResolveWstackPaths,
}));

// Mock node:fs/promises - the source uses dynamic import() for this
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { handleGoalGet, handleGoalStateMutation } from '../src/server/goal-handlers.js';

describe('goal-handlers', () => {
  beforeEach(() => {
    mockResolveWstackPaths.mockReset();
    mockReadFile.mockReset();
    mockUpdateGoal.mockReset();
  });

  describe('handleGoalGet', () => {
    it('broadcasts parsed goal when file exists and is valid JSON', async () => {
      const goalData = { objective: 'Test goal', tasks: [] };
      mockResolveWstackPaths.mockReturnValue({
        projectGoal: '/tmp/.wrongstack/projects/test/goal.json',
      });
      mockReadFile.mockResolvedValue(JSON.stringify(goalData));

      const broadcast = vi.fn();
      await handleGoalGet('/tmp/project', broadcast);

      expect(broadcast).toHaveBeenCalledWith({
        type: 'goal-state.updated',
        payload: goalData,
      });
    });

    it('broadcasts null when file read fails', async () => {
      mockResolveWstackPaths.mockReturnValue({
        projectGoal: '/tmp/.wrongstack/projects/test/goal.json',
      });
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const broadcast = vi.fn();
      await handleGoalGet('/tmp/project', broadcast);

      expect(broadcast).toHaveBeenCalledWith({
        type: 'goal-state.updated',
        payload: null,
      });
    });

    it('broadcasts null when JSON is invalid', async () => {
      mockResolveWstackPaths.mockReturnValue({
        projectGoal: '/tmp/.wrongstack/projects/test/goal.json',
      });
      mockReadFile.mockResolvedValue('not valid json');

      const broadcast = vi.fn();
      await handleGoalGet('/tmp/project', broadcast);

      expect(broadcast).toHaveBeenCalledWith({
        type: 'goal-state.updated',
        payload: null,
      });
    });
  });

  describe('handleGoalStateMutation', () => {
    it('sets a persistent mission and publishes the refreshed snapshot', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        expect(update(null)).toMatchObject({
          goal: 'Ship it',
          refinedGoal: 'Ship it',
          deliverables: ['Ship it'],
          goalState: 'active',
        });
      });
      mockReadFile.mockResolvedValue(JSON.stringify({ goal: 'Ship it', journal: [] }));
      const broadcast = vi.fn();

      await handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: ' Ship it ' },
        broadcast,
      );

      expect(mockUpdateGoal).toHaveBeenCalledWith('/tmp/goal.json', expect.any(Function));
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'goal-state.updated' }),
      );
    });

    it('keeps project links and clears prior mission evidence on replacement', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        expect(
          update({
            goal: 'old',
            kanbanBoardId: 'board-1',
            iterations: 9,
            journal: [{ iteration: 9 }],
            progress: 80,
          }),
        ).toMatchObject({
          goal: 'Build a parser; test it',
          deliverables: ['Build a parser', 'test it'],
          kanbanBoardId: 'board-1',
          iterations: 0,
          journal: [],
        });
      });
      mockReadFile.mockResolvedValue(JSON.stringify({ goal: 'Build a parser; test it' }));

      await handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: 'Build a parser; test it' },
        vi.fn(),
      );
      expect(mockUpdateGoal).toHaveBeenCalledOnce();
    });

    it('rejects an empty mission without writing', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      const broadcast = vi.fn();
      await handleGoalStateMutation('/tmp/project', 'goal-state.set', { goal: '   ' }, broadcast);
      expect(mockUpdateGoal).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'goal-state.error' }));
    });

    it('applies model refinement to the current mission', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      let current: Record<string, unknown> | null = null;
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        current = update(current);
      });
      mockReadFile.mockImplementation(async () => JSON.stringify(current));
      const broadcast = vi.fn();
      const refine = vi.fn(async () => ({
        refinedGoal: 'Ship the release with checks',
        deliverables: ['Build', 'Test'],
      }));

      await handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: 'Ship it' },
        broadcast,
        refine,
      );

      expect(refine).toHaveBeenCalledWith('Ship it');
      expect(current).toMatchObject({
        goal: 'Ship it',
        refinedGoal: 'Ship the release with checks',
        deliverables: ['Build', 'Test'],
      });
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'goal-state.refining',
          payload: expect.objectContaining({ active: true }),
        }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'goal-state.refining',
          payload: expect.objectContaining({ active: false }),
        }),
      );
    });

    it('discards a late refinement after a newer mission replaces it', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      let current: Record<string, unknown> | null = null;
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        current = update(current);
      });
      mockReadFile.mockImplementation(async () => JSON.stringify(current));
      let finishFirst!: (value: { refinedGoal: string; deliverables: string[] }) => void;
      const firstRefinement = new Promise<{ refinedGoal: string; deliverables: string[] }>(
        (resolve) => {
          finishFirst = resolve;
        },
      );
      const first = handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: 'First' },
        vi.fn(),
        () => firstRefinement,
      );
      await vi.waitFor(() => expect(current).toMatchObject({ goal: 'First' }));
      await handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: 'Second' },
        vi.fn(),
        async () => ({ refinedGoal: 'Second refined', deliverables: ['Second deliverable'] }),
      );
      finishFirst({ refinedGoal: 'Stale first result', deliverables: ['Stale'] });
      await first;

      expect(current).toMatchObject({
        goal: 'Second',
        refinedGoal: 'Second refined',
        deliverables: ['Second deliverable'],
      });
    });

    it('does not recreate a mission cleared during refinement', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      let current: Record<string, unknown> | null = null;
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        current = update(current);
      });
      mockReadFile.mockImplementation(async () => {
        if (!current) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return JSON.stringify(current);
      });
      let finish!: (value: { refinedGoal: string; deliverables: string[] }) => void;
      const pending = new Promise<{ refinedGoal: string; deliverables: string[] }>((resolve) => {
        finish = resolve;
      });
      const run = handleGoalStateMutation(
        '/tmp/project',
        'goal-state.set',
        { goal: 'Temporary' },
        vi.fn(),
        () => pending,
      );
      await vi.waitFor(() => expect(current).toMatchObject({ goal: 'Temporary' }));
      await handleGoalStateMutation('/tmp/project', 'goal-state.clear', {}, vi.fn());
      finish({ refinedGoal: 'Too late', deliverables: ['Stale'] });
      await run;
      expect(current).toBeNull();
    });

    it('refines the current mission without resetting its journal', async () => {
      mockResolveWstackPaths.mockReturnValue({ projectGoal: '/tmp/goal.json' });
      let current: Record<string, unknown> | null = {
        version: 1,
        goal: 'Existing',
        missionId: 'mission-1',
        setAt: '2026-09-22T00:00:00.000Z',
        journal: [{ iteration: 1, task: 'Done' }],
      };
      mockUpdateGoal.mockImplementation(async (_path, update) => {
        current = update(current);
      });
      mockReadFile.mockImplementation(async () => JSON.stringify(current));

      await handleGoalStateMutation('/tmp/project', 'goal-state.refine', {}, vi.fn(), async () => ({
        refinedGoal: 'Existing, made concrete',
        deliverables: ['Proof'],
      }));

      expect(current).toMatchObject({
        refinedGoal: 'Existing, made concrete',
        journal: [{ iteration: 1, task: 'Done' }],
      });
    });
  });
});
