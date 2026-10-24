import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhaseGraphBuilder, PhaseStore } from '@wrongstack/goal';
import { expect, it } from 'vitest';
import { buildGoalsCommand } from '../src/slash-commands/goals.js';

it('/goals and id lookup report all project goals with phases, sessions and unknown verification', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-goals-'));
  try {
    const store = new PhaseStore({ baseDir: dir });
    const first = await new PhaseGraphBuilder({ title: 'First', phases: [] }).build();
    first.sessionId = 'terminal-one';
    const second = await new PhaseGraphBuilder({ title: 'Second', phases: [] }).build();
    second.sessionId = 'terminal-two';
    await store.save(first);
    await store.save(second);
    const command = buildGoalsCommand({ paths: { projectAutophase: dir } } as never);
    const all = await command.run('');
    expect(all?.message).toContain(first.id);
    expect(all?.message).toContain(second.id);
    expect(all?.message).toContain('Progress: —');
    expect(all?.message).toContain('Reachability: unknown');
    const one = await command.run(first.id);
    expect(one?.message).toContain('terminal-one');
    expect(one?.message).not.toContain('terminal-two');
    expect((await command.run('missing'))?.message).toContain('Goal not found');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
