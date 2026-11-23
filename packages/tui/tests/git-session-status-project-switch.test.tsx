import { render } from 'ink-testing-library';
import type React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

// F1333: `/project` switches in place — `agent.ctx.cwd` is reassigned, the
// TUI is not remounted. The git poll stayed on the old project's watcher
// (chip frozen on the previous repo) and kept the old repo's branch as its
// baseline, so the next refresh appended a false "[system] Git branch
// switched" message to the new session.

const watchers: Array<{ root: string; cb: (e: { filename: string | null }) => void }> = [];
const branchFor = new Map<string, string>();

vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  watchProjectTree: (root: string, cb: (e: { filename: string | null }) => void) => {
    watchers.push({ root, cb });
    return { close: () => undefined };
  },
}));
vi.mock('../src/git-info.js', () => ({
  readGitInfo: async (cwd: string) => ({
    branch: branchFor.get(cwd) ?? 'unknown',
    added: 0,
    deleted: 0,
    untracked: 0,
  }),
}));

const { useGitSessionStatus } = await import('../src/hooks/use-git-session-status.js');
const { Text } = await import('../src/ink.js');

afterEach(() => vi.useRealTimers());

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(200);
}

it('follows an in-place project switch without a false branch-switch notice', async () => {
  vi.useFakeTimers();
  const appended: string[] = [];
  const ctx = {
    cwd: '/repo-a',
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

  branchFor.set('/repo-a', 'main');
  branchFor.set('/repo-b', 'feature');
  const view = render(<Probe />);
  await tick(0);
  expect(view.lastFrame()).toContain('chip:main');

  ctx.cwd = '/repo-b';
  view.rerender(<Probe />);
  await tick(10_000);
  expect(view.lastFrame()).toContain('chip:feature');
  expect(watchers.at(-1)?.root).toBe('/repo-b');

  // An edit in the old project must not produce a notice in the new session.
  watchers[0]!.cb({ filename: 'src/index.ts' });
  await tick(10_000);
  expect(appended.filter((text) => text.includes('Git branch switched'))).toEqual([]);

  // A real switch inside the new repository is still reported.
  branchFor.set('/repo-b', 'hotfix');
  watchers.at(-1)!.cb({ filename: '.git/HEAD' });
  await tick(10_000);
  expect(appended).toHaveLength(1);
  expect(appended[0]).toContain('feature → ⎇ hotfix');
  view.unmount();
});
