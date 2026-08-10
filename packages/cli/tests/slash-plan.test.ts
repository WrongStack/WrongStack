import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildPlanCommand } from '../src/slash-commands/plan.js';

function makeCtx(planPath: string, taskPath?: string) {
  const replaceTodos = vi.fn();
  return {
    planPath,
    context: {
      session: { id: 'test-session' },
      state: { replaceTodos },
      meta: taskPath ? { 'task.path': taskPath } : {},
    },
  } as never;
}

describe('/plan', () => {
  it('reports missing planPath', async () => {
    const cmd = buildPlanCommand({} as never);
    const res = await cmd.run('');
    expect((res as { message?: string })?.message).toContain('Plan storage is not configured');
  });

  it('shows an empty plan', async () => {
    const tmp = path.join(os.tmpdir(), `plan-${Date.now()}.json`);
    const cmd = buildPlanCommand(makeCtx(tmp));
    const res = await cmd.run('show');
    expect((res as { message?: string })?.message).toContain('Plan is empty');
    await fs.unlink(tmp).catch(() => {});
  });

  it('adds and completes an item', async () => {
    const tmp = path.join(os.tmpdir(), `plan-${Date.now()}.json`);
    const cmd = buildPlanCommand(makeCtx(tmp));
    let res = await cmd.run('add Test item');
    expect((res as { message?: string })?.message).toContain('Added: Test item');
    res = await cmd.run('done 1');
    expect((res as { message?: string })?.message).toContain('[x] Test item');
    await fs.unlink(tmp).catch(() => {});
  });

  it('refuses to remove or clear unfinished plan coverage', async () => {
    const tmp = path.join(os.tmpdir(), `plan-${Date.now()}-coverage.json`);
    const cmd = buildPlanCommand(makeCtx(tmp));
    await cmd.run('add Required step');

    const removed = await cmd.run('remove 1');
    const cleared = await cmd.run('clear');

    expect((removed as { message?: string })?.message).toContain('cannot be removed');
    expect((cleared as { message?: string })?.message).toContain('cannot be cleared');
    await fs.unlink(tmp).catch(() => {});
  });

  it('lists bundled templates', async () => {
    const tmp = path.join(os.tmpdir(), `plan-${Date.now()}.json`);
    const cmd = buildPlanCommand(makeCtx(tmp));
    const res = await cmd.run('template list');
    expect((res as { message?: string })?.message).toContain('Available plan templates');
    await fs.unlink(tmp).catch(() => {});
  });
});
