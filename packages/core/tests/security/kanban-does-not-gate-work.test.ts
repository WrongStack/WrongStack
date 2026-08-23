import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addTask,
  createBoard,
  evaluateContractGraphReadiness,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  readBoard,
  resolveKanbanBoundaryLayers,
} from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { evaluateToolKanbanBoundary } from '../../src/security/kanban-boundary.js';
import { setKanbanGovernance } from '../../src/security/kanban-governance-port.js';
import type { Tool } from '../../src/types/tool.js';

setKanbanGovernance({
  readBoard,
  resolveKanbanBoundaryLayers,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  evaluateContractGraphReadiness,
});

/**
 * A session must be able to do work.
 *
 * With governance enforced, a mutating tool was refused until a managed card
 * existed, carried a description and executable acceptance criteria, and had
 * been started — and with no card bound at all it was refused outright. Whole
 * sessions were spent advancing cards without ever writing a line of code.
 * These tests pin the escape routes so that failure mode cannot return
 * silently.
 */
describe('kanban boundary does not gate ordinary work', () => {
  let dir: string;

  const editTool = {
    name: 'edit',
    mutating: true,
    capabilities: ['fs.write'],
  } as unknown as Tool;

  const ctx = (over: Partial<Context> = {}) =>
    ({
      projectRoot: dir,
      workingDir: dir,
      meta: {},
      ...over,
    }) as unknown as Context;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-gate-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows a mutating tool when no board is bound at all', async () => {
    const decision = await evaluateToolKanbanBoundary(
      editTool,
      { path: 'src/index.ts' },
      ctx(),
      {},
    );
    expect(decision.decision).toBe('allow');
  });

  it('allows a mutating tool while an observational board is bound', async () => {
    // A session mirror can never be managed — task-graph sync refuses to write
    // to a managed board — so requiring managed governance from it was an
    // unrecoverable block with no reachable remedy.
    const board = await createBoard(dir, { title: 'Session mirror', kind: 'session_mirror' });
    const created = await addTask(dir, board.id, { title: 'Some work' });

    const decision = await evaluateToolKanbanBoundary(
      editTool,
      { path: 'src/index.ts' },
      ctx({ currentKanbanBoardId: board.id, currentKanbanTaskId: created?.task.id }),
      { requireGovernance: true },
    );
    expect(decision.decision).toBe('allow');
  });

  it('still refuses when governance is explicitly demanded and no board is bound', async () => {
    // The enforcement path is intact for anyone who opts into it; it is simply
    // no longer the unconditional default.
    const decision = await evaluateToolKanbanBoundary(editTool, { path: 'a.ts' }, ctx(), {
      requireGovernance: true,
    });
    expect(decision.decision).toBe('block');
  });

  it('never gates a read-only tool', async () => {
    const readTool = {
      name: 'read',
      mutating: false,
      capabilities: ['fs.read'],
    } as unknown as Tool;
    const decision = await evaluateToolKanbanBoundary(readTool, { path: 'a.ts' }, ctx(), {
      requireGovernance: true,
    });
    expect(decision.decision).toBe('allow');
  });
});
