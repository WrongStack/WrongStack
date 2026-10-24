import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  createBoard,
  getBoard,
  KanbanLifecycleError,
  listKanbanEvents,
  StaleWriteError,
} from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KANBAN_READ_ONLY_ACTIONS, kanbanTool } from '../src/kanban.js';
import { serializeKanbanOutput } from '../src/kanban-serializer.js';
import { KanbanToolError, resolveTaskRef, toKanbanToolError } from '../src/kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from '../src/kanban-tool-types.js';
import { newSignal } from './fixtures.js';
import { expectKanbanError } from './kanban-test-helpers.js';

const SID = '2026-09-13/sess_01TESTKANBANERRORCONTRACT0';

describe('kanban tool — error contract', () => {
  let dir: string;
  const ctx = (extra: Record<string, unknown> = {}) =>
    ({ eventSessionId: () => SID, projectRoot: dir, ...extra }) as unknown as Context;
  const run = (input: KanbanToolInput, c: Context = ctx(), signal = newSignal()) =>
    kanbanTool.execute(input, c, { signal });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-contract-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('failures throw instead of returning ok:false', () => {
    it('throws INVALID_INPUT as a ToolValidationError (executor category: validation)', async () => {
      const error = await expectKanbanError(
        run({ action: 'get_task' } as KanbanToolInput),
        'INVALID_INPUT',
        'requires boardId and taskId',
      );
      expect(error).toBeInstanceOf(ToolValidationError);
      expect(error.retryable).toBe(false);
    });

    it('rejects an unknown action', async () => {
      await expectKanbanError(
        run({ action: 'no_such_action' } as unknown as KanbanToolInput),
        'INVALID_INPUT',
        'Unknown kanban action',
      );
    });

    it('throws NOT_FOUND carrying the ENOENT classifier hint', async () => {
      const error = await expectKanbanError(
        run({ action: 'get_board', boardId: 'no-such-board' }),
        'NOT_FOUND',
        'Board not found',
      );
      expect((error as KanbanToolError).code).toBe('ENOENT');
      expect(error.message.startsWith('[NOT_FOUND] ')).toBe(true);
    });

    it('delete_board on a missing board is NOT_FOUND, not ok:false', async () => {
      await expectKanbanError(run({ action: 'delete_board', boardId: 'missing' }), 'NOT_FOUND');
    });

    it('lets an unrecognised error (TypeError) propagate unchanged', async () => {
      const exploding = {
        eventSessionId: () => SID,
        projectRoot: dir,
        get agentId(): string {
          throw new TypeError('ctx exploded');
        },
      } as unknown as Context;
      const rejection = run({ action: 'list_boards' }, exploding);
      await expect(rejection).rejects.toBeInstanceOf(TypeError);
      await expect(rejection).rejects.not.toHaveProperty('kanbanCode');
    });
  });

  describe('toKanbanToolError mapping', () => {
    it('maps StaleWriteError (local or IPC-shaped) to a retryable CONFLICT', () => {
      for (const err of [
        new StaleWriteError('Stale write detected for board "b"'),
        Object.assign(new Error('Stale write detected for board "b"'), { code: 'STALE_WRITE' }),
      ]) {
        const mapped = toKanbanToolError(err) as KanbanToolError;
        expect(mapped).toBeInstanceOf(KanbanToolError);
        expect(mapped.kanbanCode).toBe('CONFLICT');
        expect(mapped.retryable).toBe(true);
        expect(mapped.code).toBe('EBUSY');
      }
    });

    it('maps a lifecycle refusal to REFUSED, keeping structured issues and dropping the envelope', () => {
      const issues = [
        { code: 'transition-skipped', field: 'lifecycle', message: 'Cannot skip stages.' },
        { code: 'missing-owner', field: 'assignee', message: 'Assign an owner.' },
      ];
      const local = new KanbanLifecycleError('Cannot skip stages.', issues as never);
      // Across IPC the typed error arrives as a plain Error with the envelope.
      const wire = Object.assign(new Error(local.message), { code: 'LIFECYCLE' });
      for (const err of [local, wire]) {
        const mapped = toKanbanToolError(err) as KanbanToolError;
        expect(mapped.kanbanCode).toBe('REFUSED');
        expect(mapped.issues).toEqual(issues);
        expect(mapped.message).not.toContain('LIFECYCLE_ISSUES');
        expect(mapped.message).toContain('assignee: Assign an owner.');
        // The headline issue is not repeated in the tail.
        expect(mapped.message.split('Cannot skip stages.').length).toBe(2);
      }
    });

    it('maps daemon/IPC connection failures to a retryable UNAVAILABLE', () => {
      const mapped = toKanbanToolError(
        new Error('Kanban project server is disabled; stateful clients require IPC'),
      ) as KanbanToolError;
      expect(mapped.kanbanCode).toBe('UNAVAILABLE');
      expect(mapped.retryable).toBe(true);
      expect(mapped.code).toBe('ECONNREFUSED');
    });

    it('returns an unknown error untouched', () => {
      const plain = new RangeError('boom');
      expect(toKanbanToolError(plain)).toBe(plain);
    });

    it('treats an ambiguous id prefix as INVALID_INPUT', () => {
      const board = { tasks: [{ id: 'abc-1' }, { id: 'abc-2' }] } as never;
      expect(() => resolveTaskRef(board, 'abc')).toThrow(ToolValidationError);
      expect(resolveTaskRef(board, 'abc-2')).toEqual({ id: 'abc-2' });
      expect(resolveTaskRef(board, 'zzz')).toBeUndefined();
    });
  });

  describe('data outcomes stay return values', () => {
    it('claim_task with nothing ready returns claimed:false', async () => {
      const board = await createBoard(dir, { title: 'Empty' });
      const result = await run({ action: 'claim_task', boardId: board.id, agentId: 'a-1' });
      expect(result.ok).toBe(true);
      expect(result.claimed).toBe(false);
    });

    it('import_session_tasks with nothing to import returns imported:0', async () => {
      const result = await run({ action: 'import_session_tasks' });
      expect(result).toMatchObject({ ok: true, imported: 0 });
    });

    it('recover_stale with nothing stale returns an empty list', async () => {
      const board = await createBoard(dir, { title: 'Calm' });
      const result = await run({ action: 'recover_stale', boardId: board.id });
      expect(result).toMatchObject({ ok: true, recoveredTasks: [] });
    });
  });

  describe('Phase 1 fixes', () => {
    it('recover_stale on a missing board is NOT_FOUND, not "nothing stale"', async () => {
      await expectKanbanError(
        run({ action: 'recover_stale', boardId: 'no-such-board' }),
        'NOT_FOUND',
        'Board not found',
      );
    });

    it('add_task childTitles creates real child cards instead of fake ids', async () => {
      const board = await createBoard(dir, { title: 'Parents' });
      const result = await run({
        action: 'add_task',
        boardId: board.id,
        title: 'Parent',
        childTitles: ['Child A', 'Child B'],
      });
      expect(result.children?.map((child) => child.title)).toEqual(['Child A', 'Child B']);
      const persisted = await getBoard(dir, board.id);
      const parent = persisted!.tasks.find((task) => task.title === 'Parent')!;
      expect(parent.childTaskIds).toEqual(result.children?.map((child) => child.id));
      for (const childId of parent.childTaskIds ?? []) {
        expect(persisted!.tasks.some((task) => task.id === childId)).toBe(true);
      }
      expect(parent.childTaskIds).not.toContain('Child A');
    });

    it('does not touch presence (a board write) on read actions', async () => {
      const presenceCtx = ctx({ session: { id: SID }, agentId: 'agent-1', agentName: 'Agent' });
      const board = await createBoard(dir, { title: 'Watched' });
      await run({ action: 'add_task', boardId: board.id, title: 'Card' }, presenceCtx);
      const before = await getBoard(dir, board.id);
      expect(before?.presence?.length).toBe(1);

      await run({ action: 'get_board', boardId: board.id }, presenceCtx);
      await run({ action: 'events', boardId: board.id }, presenceCtx);
      await run({ action: 'snapshot', boardId: board.id }, presenceCtx);
      await run({ action: 'get_contract_graph', boardId: board.id }, presenceCtx);
      await run({ action: 'export_markdown', boardId: board.id }, presenceCtx);

      const after = await getBoard(dir, board.id);
      expect(after?.revision).toBe(before?.revision);
      expect(after?.presence?.[0]?.lastSeenAt).toBe(before?.presence?.[0]?.lastSeenAt);
    });

    it('every read-only action is a real action', () => {
      const actions = (kanbanTool.inputSchema as { properties: { action: { enum: string[] } } })
        .properties.action.enum;
      for (const action of KANBAN_READ_ONLY_ACTIONS) expect(actions).toContain(action);
    });

    it('reports a mutation as successful when the abort lands after it committed', async () => {
      const controller = new AbortController();
      const abortingCtx = {
        projectRoot: dir,
        eventSessionId: () => {
          controller.abort();
          return SID;
        },
      } as unknown as Context;
      const result = await kanbanTool.execute(
        { action: 'create_board', title: 'Committed anyway' },
        abortingCtx,
        { signal: controller.signal },
      );
      expect(result.ok).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      const listed = await run({ action: 'list_boards' });
      expect(listed.boards?.some((b) => b.title === 'Committed anyway')).toBe(true);
    });

    it('fails with ABORTED (an AbortError) when aborted before any work', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await expectKanbanError(
        kanbanTool.execute({ action: 'create_board', title: 'Never' }, ctx(), {
          signal: controller.signal,
        }),
        'ABORTED',
      );
      expect(error.name).toBe('AbortError');
      const listed = await run({ action: 'list_boards' });
      expect(listed.boards).toEqual([]);
    });

    it('verify_completion writes the report exactly once', async () => {
      const board = await createBoard(dir, { title: 'Verified' });
      const added = await addTask(dir, board.id, { title: 'Check me' });
      await run({
        action: 'add_check',
        boardId: board.id,
        taskId: added!.task.id,
        checkDescription: 'Looked at it',
        checkStatus: 'passed',
      });
      const revisionBefore = (await getBoard(dir, board.id))!.revision ?? 0;
      const eventsBefore = (await listKanbanEvents(dir, board.id)).length;
      const result = await run({
        action: 'verify_completion',
        boardId: board.id,
        taskId: added!.task.id,
      });
      expect(result.ok).toBe(true);
      expect(result.verdict).toBeDefined();
      expect((await getBoard(dir, board.id))!.revision ?? 0).toBe(revisionBefore + 1);
      expect((await listKanbanEvents(dir, board.id)).length).toBe(eventsBefore + 1);
    });

    it('rejects tickChecks on a transition that is not to done', async () => {
      await expectKanbanError(
        run({
          action: 'transition_task',
          boardId: 'b',
          taskId: 't',
          lifecycleStage: 'review',
          author: 'agent-1',
          transitionComment: 'Ready.',
          tickChecks: [{ checkId: 'c', checkStatus: 'passed' }],
        }),
        'INVALID_INPUT',
        'tickChecks',
      );
    });

    it('declares every field it reads and none it ignores', () => {
      const properties = (kanbanTool.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(properties).toHaveProperty('label');
      for (const dead of [
        'baseline',
        'threshold',
        'fromNodeId',
        'toNodeId',
        'moveTasksToColumnId',
      ]) {
        expect(properties).not.toHaveProperty(dead);
      }
    });

    it('start_task accepts a unique task id prefix like every other action', async () => {
      const board = await createBoard(dir, { title: 'Plain' });
      const added = await addTask(dir, board.id, { title: 'Prefixed' });
      const setCurrentKanbanTask = vi.fn();
      const result = await run(
        {
          action: 'start_task',
          boardId: board.id,
          taskId: added!.task.id.slice(0, 8),
          author: 'agent-1',
          transitionComment: 'Starting by prefix.',
        },
        ctx({ setCurrentKanbanTask }),
      );
      expect(result.task?.id).toBe(added!.task.id);
      expect(setCurrentKanbanTask).toHaveBeenCalledWith(added!.task.id, board.id);
    });

    it('delete_task by prefix unbinds the run from the deleted card', async () => {
      const board = await createBoard(dir, { title: 'Plain' });
      const added = await addTask(dir, board.id, { title: 'Doomed' });
      const setCurrentKanbanTask = vi.fn();
      await run(
        { action: 'delete_task', boardId: board.id, taskId: added!.task.id.slice(0, 8) },
        ctx({
          currentKanbanTaskId: added!.task.id,
          currentKanbanBoardId: board.id,
          setCurrentKanbanTask,
        }),
      );
      expect(setCurrentKanbanTask).toHaveBeenCalledWith(undefined, board.id);
    });
  });

  describe('large outputs', () => {
    it('export_markdown returns the markdown without the full board', async () => {
      const board = await createBoard(dir, { title: 'Exported' });
      const result = await run({ action: 'export_markdown', boardId: board.id });
      expect(result.markdown).toContain('Exported');
      expect(result.board).toBeUndefined();
    });

    it('events honours limit by returning the most recent events', async () => {
      const board = await createBoard(dir, { title: 'Busy' });
      for (const title of ['one', 'two', 'three']) {
        await run({ action: 'add_task', boardId: board.id, title });
      }
      const all = await run({ action: 'events', boardId: board.id });
      const limited = await run({ action: 'events', boardId: board.id, limit: 2 });
      expect(limited.events).toEqual(all.events!.slice(-2));
    });

    it('bounds list fields in the transcript and says so', () => {
      const events = Array.from({ length: 250 }, (_, index) => ({ id: `e${index}` }));
      const tasks = Array.from({ length: 150 }, (_, index) => ({ id: `t${index}` }));
      const text = serializeKanbanOutput(
        { ok: true, message: 'x', events, tasks } as unknown as KanbanToolOutput,
        { action: 'events' },
      );
      const parsed = JSON.parse(text) as {
        events: Array<{ id: string }>;
        tasks: Array<{ id: string }>;
        truncated: Record<string, { shown: number; total: number }>;
      };
      expect(parsed.events).toHaveLength(100);
      expect(parsed.events.at(-1)?.id).toBe('e249');
      expect(parsed.tasks[0]?.id).toBe('t0');
      expect(parsed.truncated).toEqual({
        events: { shown: 100, total: 250 },
        tasks: { shown: 100, total: 150 },
      });
    });

    it('replaces an oversized snapshot with a count summary', () => {
      const big = Array.from({ length: 2_000 }, (_, index) => ({
        id: `t${index}`,
        title: 'x'.repeat(100),
      }));
      const text = serializeKanbanOutput(
        {
          ok: true,
          message: 'x',
          snapshot: { ready: big, running: [], blocked: [] },
        } as unknown as KanbanToolOutput,
        { action: 'get_board' },
      );
      const parsed = JSON.parse(text) as { snapshot: Record<string, unknown> };
      expect(parsed.snapshot['readyCount']).toBe(2_000);
      expect(String(parsed.snapshot['note'])).toContain('omitted from the transcript');
    });
  });
});
