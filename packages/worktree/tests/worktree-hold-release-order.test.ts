import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { holdManagedWorktree } from '../src/worktree-hold.js';

const holdModule = new URL('../src/worktree-hold.ts', import.meta.url).href;

it.each([
  { name: 'a single hold', order: [0] },
  { name: 'oldest-first nested holds', order: [0, 1] },
  { name: 'newest-first nested holds', order: [1, 0] },
  { name: 'three nested holds in reverse order', order: [2, 1, 0] },
  { name: 'three nested holds in mixed order', order: [1, 2, 0] },
])('releases cross-process ownership after $name', async ({ order }) => {
  const root = await mkdtemp(join(tmpdir(), 'worktree-hold-order-'));
  const dir = join(root, 'checkout');
  // An independent process must see the persisted hold. A same-process
  // observer deliberately ignores its own PID's marker when its count is zero.
  const observe = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const { isManagedWorktreeHeld } = await import(${JSON.stringify(holdModule)});
         console.log(await isManagedWorktreeHeld(${JSON.stringify(root)}, ${JSON.stringify(dir)}));`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (let i = 0; i < order.length; i++) {
      releases.push(await holdManagedWorktree(root, dir, `owner-${i}`));
    }
    expect(observe()).toBe('true');
    for (const [position, index] of order.entries()) {
      const release = releases[index];
      if (!release) throw new Error(`Missing release ${index}`);
      await release();
      // Releases are idempotent, including while another hold remains active.
      await release();
      expect(observe()).toBe(position === order.length - 1 ? 'false' : 'true');
    }
  } finally {
    for (const release of releases) await release();
    await rm(root, { recursive: true, force: true });
  }
});
