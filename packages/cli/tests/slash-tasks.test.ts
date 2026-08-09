import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { loadCompletedWorkCheckpoint, saveTasks, type TaskFile } from '@wrongstack/core/storage';
import { createContextEvidenceState } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTasksCommand } from '../src/slash-commands/tasks.js';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-slash-tasks-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

function makeTaskFile(sessionId: string): TaskFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    updatedAt: now,
    tasks: [
      {
        id: 'task-1',
        title: 'Wire completed-work ledger',
        type: 'feature',
        priority: 'medium',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function makeCtx(taskPath: string, completedWorkPath: string): Context {
  const todos: Context['todos'] = [];
  return {
    todos,
    meta: {
      'task.path': taskPath,
      'completedWork.path': completedWorkPath,
    },
    session: { id: 'sess-1' },
    contextEvidence: createContextEvidenceState(),
    systemPrompt: [],
    state: {
      todos,
      replaceTodos: vi.fn((next: Context['todos']) => {
        todos.splice(0, todos.length, ...next);
      }),
    },
  } as never as Context;
}

describe('buildTasksCommand', () => {
  it('records completed task evidence when /tasks done completes a persisted task', async () => {
    const taskPath = path.join(tmpDir, 'tasks.json');
    const completedWorkPath = path.join(tmpDir, 'completed-work.json');
    await saveTasks(taskPath, makeTaskFile('sess-1'));
    const ctx = makeCtx(taskPath, completedWorkPath);
    const cmd = buildTasksCommand({} as never);

    const res = await cmd.run('done 1', ctx);

    expect(res?.message).toContain('Completed');
    expect(ctx.contextEvidence.completedWork[0]).toMatchObject({
      source: 'task',
      summary: 'Wire completed-work ledger',
    });
    expect(ctx.systemPrompt.some((block) => block.text.includes('[completed_work_ledger]'))).toBe(
      false,
    );
    const persisted = await loadCompletedWorkCheckpoint(completedWorkPath);
    expect(persisted?.[0]?.summary).toBe('Wire completed-work ledger');
  });
});
