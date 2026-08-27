import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, createDefaultRegistry, getBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { KANBAN_INPUT_SCHEMA } from '../src/kanban-tool-schema.js';
import { newSignal } from './fixtures.js';

describe('kanban tool — every offered checkType has a verifier', () => {
  it('the schema enum matches the default registry, plus manual', () => {
    // Two-place agreement. `verify_completion` runs against the default
    // registry, so a type offered here without a plugin there would produce
    // criteria that silently report `skipped — no verifier plugin registered`
    // — which is precisely the self-attestation this feature removes. The
    // plugin ids ARE the check-type names, so the sets compare directly.
    const offered = (
      (KANBAN_INPUT_SCHEMA.properties as Record<string, { enum?: string[] }>)['checkType']?.enum ??
      []
    ).filter((type) => type !== 'manual');
    expect([...offered].sort()).toEqual([...createDefaultRegistry().list()].sort());
  });
});

/**
 * An acceptance criterion authored through the tool must be able to be
 * EXECUTED, not merely asserted.
 *
 * Before `checkType` existed, every write path in this package hard-coded
 * `type: 'manual'` — `add_task`'s inline criterion, `add_check`, and
 * `update_check` (which could not change the type at all). The six
 * deterministic verifier plugins therefore never matched an agent-authored
 * criterion: `VerifierRegistry.verify()` found no plugin, passed the hand-set
 * status straight through, and `validateDefinitionOfDone` accepted it. So
 * "verified" meant "the author ticked its own box", and the atomicity
 * criterion `single-verifiable-output` could never score.
 *
 * These tests pin the whole round trip, because the round trip is the point:
 * writing a `command` criterion and having `verify_completion` actually run it.
 */
describe('kanban tool — acceptance criteria can be executable', () => {
  let dir: string;
  const eventContext = { sessionId: '2026-08-26/sess_TESTCRITERIA' };
  const ctx = () =>
    ({ projectRoot: dir, eventSessionId: () => eventContext.sessionId }) as unknown as Context;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-exec-criteria-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    const board = await createBoard(dir, {
      title: 'Executable criteria board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const created = await addTask(
      dir,
      board.id,
      { title: 'Card under verification' },
      eventContext,
    );
    return { boardId: board.id, taskId: created!.task.id };
  }

  const criterionOf = async (boardId: string, taskId: string) =>
    (await getBoard(dir, boardId))?.tasks.find((t) => t.id === taskId)?.successCriteria?.[0];

  it('defaults to manual so existing callers are unchanged', async () => {
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      { action: 'add_check', boardId, taskId, checkDescription: 'A human looks at it' },
      ctx(),
      { signal: newSignal() },
    );
    expect((await criterionOf(boardId, taskId))?.type).toBe('manual');
  });

  it('add_check stores the requested type and its executable body', async () => {
    const { boardId, taskId } = await seed();
    const result = await kanbanTool.execute(
      {
        action: 'add_check',
        boardId,
        taskId,
        checkDescription: 'The marker file exists',
        checkType: 'file_exists',
        checkNotes: 'evidence.txt',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);

    const criterion = await criterionOf(boardId, taskId);
    expect(criterion?.type).toBe('file_exists');
    expect(criterion?.notes).toBe('evidence.txt');
  });

  it('add_task carries the type through its inline criterion', async () => {
    const board = await createBoard(dir, {
      title: 'Inline criterion board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const result = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Card with an executable criterion',
        checkDescription: 'The marker file exists',
        checkType: 'file_exists',
        checkNotes: 'evidence.txt',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);
    expect(result.task?.successCriteria?.[0]?.type).toBe('file_exists');
    expect(result.task?.successCriteria?.[0]?.notes).toBe('evidence.txt');
  });

  it('update_check promotes an existing manual criterion to an executable one', async () => {
    // The common repair: the card was written before anyone knew the command.
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      { action: 'add_check', boardId, taskId, checkDescription: 'Marker file' },
      ctx(),
      { signal: newSignal() },
    );
    const before = await criterionOf(boardId, taskId);
    expect(before?.type).toBe('manual');

    const result = await kanbanTool.execute(
      {
        action: 'update_check',
        boardId,
        taskId,
        checkId: before!.id,
        checkType: 'file_exists',
        checkNotes: 'evidence.txt',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);

    const after = await criterionOf(boardId, taskId);
    expect(after?.type).toBe('file_exists');
    expect(after?.notes).toBe('evidence.txt');
  });

  it('verify_completion executes the criterion instead of echoing its status', async () => {
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      {
        action: 'add_check',
        boardId,
        taskId,
        checkDescription: 'The marker file exists',
        checkType: 'file_exists',
        checkNotes: 'evidence.txt',
      },
      ctx(),
      { signal: newSignal() },
    );

    // The file does not exist yet, and the criterion's stored status is
    // `pending`. A pass-through would report `skipped`; a real verifier
    // reports `failed` — that difference is the whole fix.
    const failing = await kanbanTool.execute(
      { action: 'verify_completion', boardId, taskId },
      ctx(),
      { signal: newSignal() },
    );
    expect(failing.verdict).not.toBe('skipped');
    expect((await criterionOf(boardId, taskId))?.status).toBe('failed');

    // Satisfy the criterion in the real world and re-verify. Nothing about the
    // card changed — only the filesystem did — and the verdict follows it.
    await fs.writeFile(path.join(dir, 'evidence.txt'), 'done');
    await kanbanTool.execute({ action: 'verify_completion', boardId, taskId }, ctx(), {
      signal: newSignal(),
    });
    expect((await criterionOf(boardId, taskId))?.status).toBe('passed');
  });

  it('a manual criterion still passes through its hand-set status', async () => {
    // The escape hatch must keep working: not every criterion is machine-checkable.
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      {
        action: 'add_check',
        boardId,
        taskId,
        checkDescription: 'The copy reads well',
        checkStatus: 'passed',
      },
      ctx(),
      { signal: newSignal() },
    );
    await kanbanTool.execute({ action: 'verify_completion', boardId, taskId }, ctx(), {
      signal: newSignal(),
    });
    expect((await criterionOf(boardId, taskId))?.status).toBe('passed');
  });
});
