import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function goalGitFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-multi-goal-'));
  const projectRoot = path.join(parent, 'project');
  const storeDir = path.join(projectRoot, '.wrongstack', 'task-graphs');
  await fs.mkdir(projectRoot);
  const git = async (...args: string[]) =>
    (await run('git', args, { cwd: projectRoot, windowsHide: true })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Goal Test');
  await git('config', 'user.email', 'goal@test.invalid');
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '.wrongstack/\n');
  await fs.writeFile(path.join(projectRoot, 'base.txt'), 'unchanged\n');
  await git('add', '.');
  await git('commit', '-m', 'fixture baseline');
  const baseline = await git('rev-parse', 'HEAD');
  return {
    projectRoot,
    storeDir,
    baseline,
    git,
    dispose: async () => {
      // Completed goals retain their checkouts for inspection. Release the
      // fixture's nested Git worktrees before removing their owning repository.
      const directories = (await git('worktree', 'list', '--porcelain'))
        .split('\n')
        .flatMap((line) => (line.startsWith('worktree ') ? [path.resolve(line.slice(9))] : []))
        .filter((directory) => directory.startsWith(projectRoot + path.sep))
        .sort((a, b) => b.length - a.length);
      for (const directory of directories) {
        await git('worktree', 'remove', '--force', directory);
      }
      await git('worktree', 'prune');
      await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
