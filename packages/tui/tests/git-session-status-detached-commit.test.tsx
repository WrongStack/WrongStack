import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { render } from 'ink-testing-library';
import type React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

// F1360: on a detached HEAD the git chip shows the short OID, so a commit made
// there (a rebase step, an agent commit during `git rebase`) moved the label
// and the poll told the model "[system] Git branch switched: ⎇ <sha> → ⎇ <sha>
// … Any file changes from the previous branch are no longer visible" — no
// branch moved and no file disappeared. Real git and readGitInfo; only the
// watcher is stubbed so the test can signal a change, and setInterval is faked.

const watchers: Array<(e: { filename: string | null }) => void> = [];
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  watchProjectTree: (_root: string, cb: (e: { filename: string | null }) => void) => {
    watchers.push(cb);
    return { close: () => undefined };
  },
}));

const { useGitSessionStatus } = await import('../src/hooks/use-git-session-status.js');
const { Text } = await import('../src/ink.js');

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

async function repo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git-detached-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await fsp.writeFile(path.join(dir, 'a.txt'), '1\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(check()).toBe(true);
}

/** Render the hook on `cwd`, run `step`, signal a HEAD change, and return the notices. */
async function noticesAfter(cwd: string, step: () => unknown, chip: () => string) {
  const appended: string[] = [];
  const ctx = {
    cwd,
    state: {
      appendMessage: (m: { content: Array<{ text: string }> }) => appended.push(m.content[0]!.text),
    },
  };
  const agent = { ctx } as never;
  function Probe(): React.ReactElement {
    const info = useGitSessionStatus({
      agent,
      getLiveSessions: undefined,
      setSessionCount: () => undefined,
    });
    return <Text>{`chip:${info?.branch ?? 'none'}`}</Text>;
  }
  const before = watchers.length;
  const view = render(<Probe />);
  await until(() => !(view.lastFrame() ?? '').includes('chip:none'));
  await step();
  watchers[before]!({ filename: '.git/HEAD' });
  await vi.advanceTimersByTimeAsync(10_000);
  const want = chip();
  await until(() => (view.lastFrame() ?? '').includes(`chip:${want}`));
  view.unmount();
  return appended.filter((text) => text.includes('Git branch switched'));
}

it('a commit on a detached HEAD is not reported as a branch switch', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const dir = await repo();
  git(dir, 'checkout', '-q', '--detach');
  const notices = await noticesAfter(
    dir,
    async () => {
      await fsp.writeFile(path.join(dir, 'a.txt'), '2\n');
      git(dir, 'commit', '-q', '-am', 'detached commit');
    },
    () => git(dir, 'rev-parse', '--short=7', 'HEAD'),
  );
  expect(notices).toEqual([]);
}, 60_000);

it('leaving and entering a detached HEAD are still reported', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const dir = await repo();
  const sha = git(dir, 'rev-parse', '--short=7', 'HEAD');
  const entering = await noticesAfter(
    dir,
    () => git(dir, 'checkout', '-q', '--detach'),
    () => sha,
  );
  expect(entering).toHaveLength(1);
  expect(entering[0]).toContain(`main → ⎇ ${sha}`);
  const leaving = await noticesAfter(
    dir,
    () => git(dir, 'checkout', '-q', 'main'),
    () => 'main',
  );
  expect(leaving).toHaveLength(1);
  expect(leaving[0]).toContain(`${sha} → ⎇ main`);
}, 60_000);
