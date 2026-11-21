import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleGitDiscard } from '../src/server/git-handlers.js';

// `git.discard` refuses an empty path list. A path naming the project directory
// itself translated to `.` and discarded everything instead: a restore to HEAD
// plus `git clean -fd -- .`, deleting every untracked file in the project. An
// untracked project directory reaches this from one click, because
// `git status --porcelain` lists it as a single `proj/` entry.

function mockWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = { readyState: 1, sent, send: (d: string) => void sent.push(JSON.parse(d)) };
  return ws as unknown as WebSocket & { sent: typeof sent };
}
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const result = (ws: ReturnType<typeof mockWs>) =>
  ws.sent.find((m) => m.type === 'git.action_result')?.payload;

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

function untrackedProject(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-discard-root-'));
  repos.push(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.dev']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'root.txt'), 'root\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const proj = path.join(repo, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'unsaved work\n');
  fs.writeFileSync(path.join(proj, 'src', 'main.ts'), 'export const x = 1;\n');
  return proj;
}

describe('git.discard never discards the whole project', () => {
  it.each([['proj/'], ['proj'], ['.'], ['./']])(
    'refuses %j, a path naming the project directory itself',
    async (target) => {
      const proj = untrackedProject();
      const ws = mockWs();
      await handleGitDiscard(ws, proj, [target]);
      expect(result(ws)).toMatchObject({ action: 'discard', ok: false });
      expect(fs.existsSync(path.join(proj, 'notes.txt'))).toBe(true);
      expect(fs.existsSync(path.join(proj, 'src', 'main.ts'))).toBe(true);
    },
  );

  it.each([['.'], ['./'], ['.//']])(
    'refuses %j in a project that is the repository root',
    async (target) => {
      const proj = untrackedProject();
      const repo = path.dirname(proj);
      fs.writeFileSync(path.join(repo, 'root.txt'), 'edited\n');
      const ws = mockWs();
      await handleGitDiscard(ws, repo, [target]);
      expect(result(ws)).toMatchObject({ action: 'discard', ok: false });
      expect(fs.readFileSync(path.join(repo, 'root.txt'), 'utf8')).toBe('edited\n');
      expect(fs.existsSync(path.join(proj, 'notes.txt'))).toBe(true);
    },
  );

  it('refuses the whole batch when one entry names the project directory', async () => {
    const proj = untrackedProject();
    const ws = mockWs();
    await handleGitDiscard(ws, proj, ['proj/notes.txt', 'proj/']);
    expect(result(ws)).toMatchObject({ action: 'discard', ok: false });
    expect(fs.existsSync(path.join(proj, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(proj, 'src', 'main.ts'))).toBe(true);
  });

  it('still discards an explicit file and an explicit subdirectory', async () => {
    const proj = untrackedProject();
    const file = mockWs();
    await handleGitDiscard(file, proj, ['proj/notes.txt']);
    expect(result(file)).toMatchObject({ action: 'discard', ok: true });
    expect(fs.existsSync(path.join(proj, 'notes.txt'))).toBe(false);
    const dir = mockWs();
    await handleGitDiscard(dir, proj, ['proj/src/']);
    expect(result(dir)).toMatchObject({ action: 'discard', ok: true });
    expect(fs.existsSync(path.join(proj, 'src', 'main.ts'))).toBe(false);
  });
});
