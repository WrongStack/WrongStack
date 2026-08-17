import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { SpecStore } from '@wrongstack/sdd';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sddState } from '../src/services/sdd/state.js';
import { buildSddCommand } from '../src/slash-commands/sdd.js';
import { createMockTracker, createTestSddSession } from './helpers/sdd-test-helpers.js';

let tmp: string;
let prevCwd: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-gaps-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

async function rmWithRetry(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if (i === 4) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

afterEach(async () => {
  try {
    await build().run('cancel');
  } catch {
    /* best-effort state cleanup */
  }
  sddState.clearTaskState();
  process.chdir(prevCwd);
  await new Promise((r) => setImmediate(r));
  await rmWithRetry(tmp);
});

function fakeCtx() {
  return { projectRoot: tmp, meta: {} } as never;
}

/** Persist a real spec through the same store the command reads. */
async function saveSpec(
  title: string,
  requirements: Array<{
    id: string;
    type: 'functional';
    description: string;
    priority: 'high';
    acceptanceCriteria: string[];
  }> = [],
) {
  const store = new SpecStore({
    baseDir: resolveWstackPaths({ projectRoot: tmp }).projectSpecs,
  });
  const spec = await store.createDraft(title, 'An overview.');
  if (requirements.length > 0) await store.update(spec.id, { requirements });
  return spec;
}

function build() {
  return buildSddCommand({
    sddSessionTransport: 'legacy-file',
    context: fakeCtx(),
    paths: resolveWstackPaths({ projectRoot: tmp }),
  } as never);
}

describe('/sdd task-status subcommands', () => {
  it('done marks a task complete by number and by title', async () => {
    createMockTracker([
      ['t1', 'Write the README'],
      ['t2', 'Write the tests'],
    ]);
    const cmd = build();

    const byNumber = await cmd.run('done 1');
    expect(byNumber?.message).toContain('✅ Task marked done! (1/2');

    const byTitle = await cmd.run('done Write the tests');
    expect(byTitle?.message).toContain('2/2');
  });

  it('done reports missing tracker, usage, and unknown tasks', async () => {
    const cmd = build();
    expect((await cmd.run('done 1'))?.message).toBe('No tasks to complete.');

    createMockTracker([['t1', 'Only task']]);
    expect((await cmd.run('done'))?.message).toContain('Usage: /sdd done');
    expect((await cmd.run('done nope'))?.message).toContain('No pending task matching "nope".');
  });

  it('skip moves a blocked task back to pending', async () => {
    createMockTracker([
      ['t1', 'Stuck task', 'blocked'],
      ['t2', 'Done task', 'completed'],
    ]);
    const out = await build().run('skip Stuck task');
    expect(out?.message).toContain('⏭ Task skipped — moved to pending.');
  });

  it('fail marks a task failed with the failure count', async () => {
    createMockTracker([['t1', 'Broken task']]);
    const out = await build().run('fail Broken task');
    expect(out?.message).toContain('❌ Task marked as failed. (1 failed · 0/1 done)');
  });

  it('review sends a task to review', async () => {
    createMockTracker([['t1', 'Needs eyes']]);
    const out = await build().run('review 1');
    expect(out?.message).toContain('👁 Task sent to review. (1 in review)');
  });

  it('edit updates the title for short content and description for long', async () => {
    createMockTracker([['t1', 'Old title']]);
    const cmd = build();

    const title = await cmd.run('edit 1 New title');
    expect(title?.message).toContain('✏️ Task #1 updated: "New title"');
    const tracker = sddState.getTaskTracker();
    expect(tracker?.getAllNodes()[0]?.title).toBe('New title');

    const long = 'L'.repeat(70);
    await cmd.run(`edit 1 ${long}`);
    expect(tracker?.getAllNodes()[0]?.description).toBe(long);
  });

  it('edit rejects malformed input', async () => {
    createMockTracker([['t1', 'Task']]);
    const cmd = build();
    expect((await cmd.run('edit'))?.message).toContain('Usage: /sdd edit');
    expect((await cmd.run('edit abc content'))?.message).toContain('Usage: /sdd edit');
    expect((await cmd.run('edit 9 content'))?.message).toContain('Task #9 not found.');
    expect((await cmd.run('edit 1'))?.message).toContain('Provide new title or description');
  });

  it('undo reverts the most recently completed task', async () => {
    createMockTracker([
      ['t1', 'First', 'completed'],
      ['t2', 'Second', 'completed'],
    ]);
    const out = await build().run('undo');
    expect(out?.message).toContain('↩ Undo: "Second" back to pending. (1/2');
  });

  it('undo reports when nothing is completed', async () => {
    createMockTracker([['t1', 'Pending task']]);
    expect((await build().run('undo'))?.message).toBe('No completed tasks to undo.');
  });
});

describe('/sdd next', () => {
  it('requires generated tasks', async () => {
    expect((await build().run('next'))?.message).toContain('No tasks generated yet.');
  });

  it('celebrates when everything is done', async () => {
    createMockTracker([['t1', 'Only', 'completed']]);
    const out = await build().run('next');
    expect(out?.message).toContain('🎉 All tasks completed!');
  });

  it('previews the next executable task', async () => {
    createMockTracker([['t1', 'First up'], ['t2', 'Later']]);
    const out = await build().run('next');
    expect(out?.message).toContain('NEXT TASK');
    expect(out?.message).toContain('First up');
  });
});

describe('/sdd status and graph', () => {
  it('status reports no active session without a builder', async () => {
    expect((await build().run('status'))?.message).toBe('No active SDD session.');
  });

  it('status renders the session view once a builder exists', async () => {
    await createTestSddSession('Gap Session', tmp);
    const out = await build().run('status');
    expect(out?.message).toContain('SDD:');
    expect(out?.message).toContain('Phase: Spec Review');
    expect(out?.message).toContain('Session ID:');
  });

  it('graph falls back to the list view without a stored graph id', async () => {
    createMockTracker([['t1', 'Visible task', 'in_progress']]);
    const out = await build().run('graph');
    expect(out?.message).toContain('Visible task');
  });

  it('graph reports empty boards', async () => {
    expect((await build().run('graph'))?.message).toContain('No tasks generated yet.');

    createMockTracker([]);
    expect((await build().run('graph'))?.message).toContain('No tasks in the current graph.');
  });
});

describe('/sdd spec catalog commands', () => {
  it('list reports an empty spec store', async () => {
    expect((await build().run('list'))?.message).toContain('No specs saved.');
  });

  it('list shows saved specs', async () => {
    await saveSpec('Catalogued Spec');
    const out = await build().run('ls');
    expect(out?.message).toContain('Saved Specs:');
    expect(out?.message).toContain('Catalogued Spec');
  });

  it('show rejects unknown specs', async () => {
    expect((await build().run('show does-not-exist'))?.message).toContain(
      'Spec "does-not-exist" not found.',
    );
  });

  it('show renders a stored spec with requirements and analysis', async () => {
    const spec = await saveSpec('Showable Spec', [
      {
        id: 'r1',
        type: 'functional',
        description: 'Must render',
        priority: 'high',
        acceptanceCriteria: ['fast'],
      },
    ]);
    const out = await build().run(`show ${spec.id}`);
    expect(out?.message).toContain('# Showable Spec');
    expect(out?.message).toContain('## Requirements (1)');
    expect(out?.message).toContain('[functional][high] Must render');
    expect(out?.message).toContain('AC: fast');
  });

  it('templates lists the available spec templates', async () => {
    const out = await build().run('templates');
    expect(out?.message).toContain('Available Templates:');
    expect((out?.message?.match(/\n/g) ?? []).length).toBeGreaterThan(2);
  });

  it('from creates a draft from a known template and rejects unknown ones', async () => {
    const bad = await build().run('from nope');
    expect(bad?.message).toContain('Template "nope" not found.');

    const good = await build().run('from');
    expect(good?.message).toContain('Created draft spec from template');
    expect(good?.message).toContain('ID:');
  });

  it('version history reports specs without versions', async () => {
    const spec = await saveSpec('Unversioned');
    const out = await build().run(`version ${spec.id}`);
    expect(out?.message).toContain('No version history for "Unversioned".');
  });

  it('version rejects unknown specs', async () => {
    expect((await build().run('history nope'))?.message).toContain('Spec "nope" not found.');
  });

  it('critical requires tasks and a stored graph', async () => {
    expect((await build().run('critical'))?.message).toContain('No tasks generated yet.');

    createMockTracker([['t1', 'Task']]);
    expect((await build().run('bottleneck'))?.message).toContain(
      'No task graph found. Generate tasks first.',
    );
  });
});
