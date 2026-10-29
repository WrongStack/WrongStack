import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { handleGitHunks, partialHunk } from '../src/server/git-hunks.js';
import { handleShellGitRoute } from '../src/server/shell-git-routes.js';

it('stages and unstages only the reviewed hunk, refuses stale diffs, and keeps worktree bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-hunks-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const frames: { type: string; payload: Record<string, any> }[] = [];
  const ws = { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) };
  const invoke = async (type: string, payload: Record<string, unknown>, project = root) => {
    frames.length = 0;
    await handleShellGitRoute(
      ws as never,
      { type, payload: { ...payload, requestId: 'hunk-proof' } } as never,
      {
        gitHunks: (
          socket: import('ws').WebSocket,
          message: import('../src/server/types.js').WSClientMessage,
        ) => handleGitHunks(socket, project, message.payload, message.type === 'git.hunk.apply'),
      } as never,
    );
    expect(frames.at(-1)?.payload.requestId).toBe('hunk-proof');
    return frames.at(-1)!.payload;
  };
  try {
    git('init');
    const original = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(root, 'sample.txt'), original);
    await writeFile(join(root, 'legacy.txt'), Buffer.from([0xff, 10]));
    git('add', '.');
    git(
      '-c',
      'user.name=Native Test',
      '-c',
      'user.email=native@example.invalid',
      '-c',
      'core.hooksPath=disabled',
      'commit',
      '-m',
      'fixture',
    );
    const edited = original
      .replace('line 3\n', 'first change\n')
      .replace('line 39\n', 'second change\n');
    await writeFile(join(root, 'sample.txt'), edited);
    const view = await invoke('git.hunks', { path: 'sample.txt', layer: 'unstaged' });
    expect(view.hunks).toHaveLength(2);
    expect(
      (
        await invoke('git.hunk.apply', {
          path: 'sample.txt',
          layer: 'unstaged',
          patchId: view.patchId,
          hunk: 0,
        })
      ).ok,
    ).toBe(true);
    expect(git('show', ':sample.txt')).toBe(original.replace('line 3\n', 'first change\n'));
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toBe(edited);
    const stale = await invoke('git.hunks', { path: 'sample.txt', layer: 'unstaged' });
    await writeFile(join(root, 'sample.txt'), edited.replace('second change', 'newer change'));
    expect(
      (
        await invoke('git.hunk.apply', {
          path: 'sample.txt',
          layer: 'unstaged',
          patchId: stale.patchId,
          hunk: 0,
        })
      ).error,
    ).toMatch(/changed since review/);
    const staged = await invoke('git.hunks', { path: 'sample.txt', layer: 'staged' });
    expect(staged.hunks).toHaveLength(1);
    expect(
      (
        await invoke('git.hunk.apply', {
          path: 'sample.txt',
          layer: 'staged',
          patchId: staged.patchId,
          hunk: 0,
        })
      ).ok,
    ).toBe(true);
    expect(git('show', ':sample.txt')).toBe(original);
    expect(await readFile(join(root, 'sample.txt'), 'utf8')).toContain('newer change');
    await mkdir(join(root, 'nested'));
    expect(
      (await invoke('git.hunks', { path: 'sample.txt', layer: 'unstaged' }, join(root, 'nested')))
        .ok,
    ).toBe(false);
    expect((await invoke('git.hunks', { path: '../sample.txt', layer: 'unstaged' })).ok).toBe(
      false,
    );
    expect((await invoke('git.hunks', { path: 'sample.txt', layer: 'wrong' })).ok).toBe(false);
    await writeFile(join(root, 'legacy.txt'), Buffer.from([0xfe, 10]));
    expect((await invoke('git.hunks', { path: 'legacy.txt', layer: 'unstaged' })).error).toMatch(
      /UTF-8/,
    );
    await writeFile(join(root, 'new.txt'), 'New file\n');
    expect((await invoke('git.hunks', { path: 'new.txt', layer: 'unstaged' })).hunks).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stages and unstages selected lines of one hunk only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-lines-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const frames: { type: string; payload: Record<string, any> }[] = [];
  const ws = { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) };
  const run = async (apply: boolean, payload: Record<string, unknown>) => {
    frames.length = 0;
    await handleGitHunks(ws as never, root, payload, apply);
    return frames.at(-1)!.payload;
  };
  try {
    git('init');
    const original = ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n';
    await writeFile(join(root, 'f.txt'), original);
    git('add', '.');
    git(
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'core.hooksPath=disabled',
      'commit',
      '-m',
      'x',
    );
    // One hunk: b and c replaced by B and C.
    const edited = ['a', 'B', 'C', 'd', 'e'].join('\n') + '\n';
    await writeFile(join(root, 'f.txt'), edited);
    const view = await run(false, { path: 'f.txt', layer: 'unstaged' });
    expect(view.hunks).toHaveLength(1);
    const body: string[] = view.hunks[0].text.split('\n').slice(1);
    const at = (line: string) => body.indexOf(line);
    // Stage only "-b" and "+B": c stays as it was in the index.
    const staged = await run(true, {
      path: 'f.txt',
      layer: 'unstaged',
      patchId: view.patchId,
      hunk: 0,
      lines: [at('-b'), at('+B')],
    });
    expect(staged).toMatchObject({ ok: true, action: 'stage-lines' });
    expect(git('show', ':f.txt')).toBe(['a', 'B', 'c', 'd', 'e'].join('\n') + '\n');
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe(edited);
    // Unstage only "+B" from the staged layer: the index loses B but keeps b removed.
    const stagedView = await run(false, { path: 'f.txt', layer: 'staged' });
    const stagedBody: string[] = stagedView.hunks[0].text.split('\n').slice(1);
    const unstaged = await run(true, {
      path: 'f.txt',
      layer: 'staged',
      patchId: stagedView.patchId,
      hunk: 0,
      lines: [stagedBody.indexOf('+B')],
    });
    expect(unstaged).toMatchObject({ ok: true, action: 'unstage-lines' });
    expect(git('show', ':f.txt')).toBe(['a', 'c', 'd', 'e'].join('\n') + '\n');
    // Context lines, out-of-range and empty selections are refused.
    const again = await run(false, { path: 'f.txt', layer: 'unstaged' });
    const againBody: string[] = again.hunks[0].text.split('\n').slice(1);
    for (const lines of [[againBody.indexOf('a')], [999], []])
      expect(
        (
          await run(true, {
            path: 'f.txt',
            layer: 'unstaged',
            patchId: again.patchId,
            hunk: 0,
            lines,
          })
        ).ok,
      ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('builds partial hunks that keep the applied side in order', () => {
  const hunk = '@@ -1,4 +1,4 @@ ctx\n a\n-b\n-c\n+B\n+C\n';
  // Forward, only the addition of C: removals stay as context, C after them.
  expect(partialHunk(hunk, [4], false)).toBe('@@ -1,3 +1,4 @@ ctx\n a\n b\n c\n+C\n');
  // Forward, b→B: B right after the removed b, c kept.
  expect(partialHunk(hunk, [1, 3], false)).toBe('@@ -1,3 +1,3 @@ ctx\n a\n-b\n+B\n c\n');
  // Reverse (unstaging), only C: B stays as context, the selected removal goes before C.
  expect(partialHunk(hunk, [2, 4], true)).toBe('@@ -1,3 +1,3 @@ ctx\n a\n B\n-c\n+C\n');
  expect(() =>
    partialHunk('@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n', [0], false),
  ).toThrow(/end-of-file newline/);
});
