import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleGitChanges,
  handleGitCommit,
  handleGitDiff,
  handleGitDiscard,
  handleGitStage,
  handleGitUnstage,
  repoRelativePrefix,
} from '@wrongstack/webui-server';

/** Minimal ws mock that records parsed JSON sends. */
function createMockWs() {
  const ws = {
    readyState: 1,
    sent: [] as Array<{ type: string; payload: Record<string, unknown> }>,
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
  } as never as WebSocket & { sent: Array<{ type: string; payload: Record<string, unknown> }> };
  return ws;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('git change-set handlers', () => {
  let repo: string;

  beforeEach(() => {
    repo = path.join(process.env.TEMP || '/tmp', `gittest-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@test.dev']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // Seed a committed baseline.
    fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nline2\nline3\n');
    fsSync.writeFileSync(path.join(repo, 'gone.txt'), 'remove me\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('handleGitChanges', () => {
    it('reports modified, untracked, and deleted files without reading untracked counts', async () => {
      // modify
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nCHANGED\nline3\nline4\n');
      // untracked new file
      fsSync.writeFileSync(path.join(repo, 'fresh.txt'), 'a\nb\nc\n');
      // delete
      fsSync.rmSync(path.join(repo, 'gone.txt'));

      const ws = createMockWs();
      await handleGitChanges(ws, repo);

      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]?.type).toBe('git.changes');
      const files = ws.sent[0]?.payload.files as Array<{
        path: string;
        status: string;
        added: number;
        deleted: number;
        staged: boolean;
      }>;
      const byPath = new Map(files.map((f) => [f.path, f]));

      expect(byPath.get('keep.txt')?.status).toBe('M');
      expect(byPath.get('keep.txt')?.added).toBeGreaterThan(0);

      expect(byPath.get('fresh.txt')?.status).toBe('?');
      expect(byPath.get('fresh.txt')?.added).toBe(0);
      expect(byPath.get('fresh.txt')?.deleted).toBe(0);
      expect(byPath.get('fresh.txt')?.staged).toBe(false);

      expect(byPath.get('gone.txt')?.status).toBe('D');
    });

    it('flags staged changes', async () => {
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'staged change\n');
      git(repo, ['add', 'keep.txt']);

      const ws = createMockWs();
      await handleGitChanges(ws, repo);
      const files = ws.sent[0]?.payload.files as Array<{ path: string; staged: boolean }>;
      expect(files.find((f) => f.path === 'keep.txt')?.staged).toBe(true);
    });

    it('returns an empty list for a clean tree', async () => {
      const ws = createMockWs();
      await handleGitChanges(ws, repo);
      expect(ws.sent[0]?.payload.files).toEqual([]);
    });

    it('reports repoPrefix so the client can map repo-relative git paths to project-relative tree paths', async () => {
      // Project root = repo root → no prefix.
      const ws = createMockWs();
      await handleGitChanges(ws, repo);
      expect(ws.sent[0]?.payload.repoPrefix).toBe('');

      // Project root = repo SUBDIRECTORY → git paths carry this prefix.
      // The file must be TRACKED before the edit: porcelain collapses a
      // fully-untracked directory to its top entry (`?? packages/`), which
      // would not prove the path shape. A tracked-then-modified file is
      // always reported individually, repo-root-relative.
      const sub = path.join(repo, 'packages', 'webui');
      fsSync.mkdirSync(sub, { recursive: true });
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export {};\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'sub package baseline']);
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export { changed: true };\n');
      const wsSub = createMockWs();
      await handleGitChanges(wsSub, sub);
      const subPayload = wsSub.sent[0]?.payload as {
        repoPrefix?: string;
        files?: Array<{ path: string; status: string }>;
      };
      expect(subPayload?.repoPrefix).toBe('packages/webui/');
      // Porcelain paths stay REPO-relative…
      const paths = (subPayload?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
      expect(paths).toContain('packages/webui/index.ts');
    });

    it('repoRelativePrefix: subdirectory, equal roots, outside, and Windows separators', () => {
      expect(repoRelativePrefix('/repo', '/repo')).toBe('');
      expect(repoRelativePrefix('/repo', '/repo/packages/webui')).toBe('packages/webui/');
      // Project outside the repo → '' (git would fail there anyway).
      expect(repoRelativePrefix('/repo', '/elsewhere')).toBe('');
      // Backslash-form inputs are only meaningful where node:path treats
      // '\' as a separator; on POSIX they are opaque single segments, so
      // the helper correctly reports no relation. Assert both ways so the
      // suite stays green on Windows dev boxes AND Linux CI.
      const windowsForm = repoRelativePrefix('D:\\repo', 'D:\\repo\\apps\\demo');
      if (process.platform === 'win32') {
        expect(windowsForm).toBe('apps/demo/');
      } else {
        expect(windowsForm).toBe('');
      }
    });

    it('never throws outside a git repo', async () => {
      const notRepo = path.join(process.env.TEMP || '/tmp', `notgit-${randomBytes(4).toString('hex')}`);
      fsSync.mkdirSync(notRepo, { recursive: true });
      try {
        const ws = createMockWs();
        await handleGitChanges(ws, notRepo);
        expect(ws.sent[0]?.type).toBe('git.changes');
        expect(ws.sent[0]?.payload.files).toEqual([]);
      } finally {
        fsSync.rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  describe('handleGitStage/Unstage/Discard with a subdirectory project root', () => {
    // Regression (chimera): `git.changes` emits REPO-relative paths, but
    // the action handlers execute git with cwd=projectRoot. When the
    // project is a repo subdirectory, `packages/webui/index.ts` used to
    // resolve beneath the subdir again (double-nest) — staging silently
    // did nothing. The handlers now strip the repo prefix first.
    let sub: string;

    beforeEach(() => {
      sub = path.join(repo, 'packages', 'webui');
      fsSync.mkdirSync(sub, { recursive: true });
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 1;\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'sub package baseline']);
      // Tracked-then-modified so porcelain reports the individual path.
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 2;\n');
    });

    const stagedState = (): string => {
      // First two chars of the porcelain line: XY. X = index, Y = worktree.
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: sub,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const line = out
        .split('\n')
        .find((l) => l.replace(/\\/g, '/').includes('packages/webui/index.ts'));
      return line?.slice(0, 2) ?? '';
    };

    it('stages a repo-relative pathspec against a subdirectory project', async () => {
      const ws = createMockWs();
      await handleGitStage(ws, sub, ['packages/webui/index.ts']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      expect(result?.payload.paths).toEqual(['packages/webui/index.ts']);
      // X column 'M' proves the index actually changed — the double-nest
      // bug left it ' ' (unstaged) while still reporting ok:true.
      expect(stagedState()).toBe('M ');
    });

    it('unstages a repo-relative pathspec against a subdirectory project', async () => {
      git(sub, ['add', 'index.ts']);
      expect(stagedState()).toBe('M ');
      const ws = createMockWs();
      await handleGitUnstage(ws, sub, ['packages/webui/index.ts']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      expect(stagedState()).toBe(' M');
    });

    it('discards a repo-relative pathspec against a subdirectory project', async () => {
      const ws = createMockWs();
      await handleGitDiscard(ws, sub, ['packages/webui/index.ts']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      // Content restored to HEAD — the discard actually executed.
      expect(fsSync.readFileSync(path.join(sub, 'index.ts'), 'utf8')).toContain('v = 1');
    });

    it('rejects a repo-relative path outside the opened subdirectory project', async () => {
      // keep.txt lives at the repo root — outside the packages/webui
      // project. A repo-relative pathspec for it must be refused, not
      // executed (translation must not widen the write surface).
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nEDITED\n');
      const ws = createMockWs();
      await handleGitStage(ws, sub, ['keep.txt']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(false);
      expect(result?.payload.error).toContain('outside project root');
      expect(stagedState()).toBe(' M');
    });

    it('git diff reads HEAD and the working tree through a subdirectory project', async () => {
      // The `git show HEAD:<repo-relative>` rev syntax is repo-root-
      // relative from any cwd, but the working-tree readFile joins
      // against projectRoot — without prefix translation every file
      // read as deleted (empty newText) in a subdirectory project.
      const ws = createMockWs();
      await handleGitDiff(ws, sub, 'packages/webui/index.ts');
      const p = ws.sent[0]?.payload as { oldText: string; newText: string; error?: string };
      expect(p.error).toBeUndefined();
      expect(p.oldText).toBe('export const v = 1;\n');
      expect(p.newText).toBe('export const v = 2;\n');
    });

    it('empty-array stage-all stays contained to the subdirectory project', async () => {
      // Root-level keep.txt is also modified; an "all" stage from the
      // packages/webui project must NOT touch it. Bare `git add -A`
      // stages the entire repository since Git 2.0 — the explicit `.`
      // pathspec limits the sweep to the execution cwd.
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nROOT EDIT\n');
      const ws = createMockWs();
      await handleGitStage(ws, sub, []);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      // The sub project's file IS staged…
      expect(stagedState()).toBe('M ');
      // …but the repo-root file is NOT.
      const rootOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const keepLine = rootOut.split('\n').find((l) => l.endsWith('keep.txt'));
      expect(keepLine?.slice(0, 2)).toBe(' M');
    });

    it('discard of a mixed tracked+untracked batch restores the tracked file', async () => {
      // Regression (chimera round-2): a single `git restore` over both
      // pathspecs fails wholesale on the untracked name, so the tracked
      // sibling never restored while the handler reported ok:true.
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 3;\n');
      fsSync.writeFileSync(path.join(sub, 'scratch.txt'), 'temp\n');
      const before = fsSync.readFileSync(path.join(sub, 'index.ts'), 'utf8');
      expect(before).toContain('v = 3');

      const ws = createMockWs();
      await handleGitDiscard(ws, sub, ['packages/webui/index.ts', 'packages/webui/scratch.txt']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      // Tracked file restored to HEAD — the baseline commit's v = 1 (the
      // beforeEach writes v = 2 as the working-tree modification).
      expect(fsSync.readFileSync(path.join(sub, 'index.ts'), 'utf8')).toContain('v = 1');
      // …and the untracked file was cleaned.
      expect(fsSync.existsSync(path.join(sub, 'scratch.txt'))).toBe(false);
    });

    it('accepts a legal double-dot filename while rejecting traversal', async () => {
      // `release..notes.md` is one segment containing '..', not traversal.
      fsSync.writeFileSync(path.join(repo, 'release..notes.md'), 'notes\n');
      const ws = createMockWs();
      await handleGitStage(ws, repo, ['release..notes.md']);
      const ok = ws.sent.find((m) => m.type === 'git.action_result');
      expect(ok?.payload.ok).toBe(true);

      const wsBad = createMockWs();
      await handleGitStage(wsBad, repo, ['a/../keep.txt']);
      const bad = wsBad.sent.find((m) => m.type === 'git.action_result');
      expect(bad?.payload.ok).toBe(false);
      expect(bad?.payload.error).toContain('unsafe');
    });

    it('stages the project directory itself (no trailing separator) in a subdir project', async () => {
      // Regression (chimera round-3): `packages/webui` — the project
      // directory — carries no trailing slash, so a plain
      // startsWith('packages/webui/') rejected it as outside the project.
      // The boundary match must treat it as the project root ('.').
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 9;\n');
      const ws = createMockWs();
      await handleGitStage(ws, sub, ['packages/webui']);
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      expect(stagedState()).toBe('M ');
    });

    it('rejects pathspec magic — a :(top) escape must not reach the repo root', async () => {
      // Regression (chimera round-4, security): `packages/webui/:(top)keep.txt`
      // strips to `:(top)keep.txt`, and git's :(top) magic re-anchors the
      // pathspec at the REPO root — targeting a file outside the project.
      // GIT_LITERAL_PATHSPECS disables magic, so the literal name matches
      // nothing and the action fails contained (or no-ops), never escaping.
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nMAGIC TARGET\n');
      const before = fsSync.readFileSync(path.join(repo, 'keep.txt'), 'utf8');
      const ws = createMockWs();
      await handleGitStage(ws, sub, ['packages/webui/:(top)keep.txt']);
      // Whatever the outcome, keep.txt must NOT be staged by this action.
      const rootOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const keepLine = rootOut.split('\n').find((l) => l.endsWith('keep.txt'));
      expect(keepLine?.slice(0, 1)).toBe(' '); // X column not staged
      expect(fsSync.readFileSync(path.join(repo, 'keep.txt'), 'utf8')).toBe(before);
    });

    it('repoRelativePrefix treats a legal ..hidden directory as inside the repo', () => {
      // Regression (chimera round-4): a raw startsWith('..') check
      // reported "no relation" for a project under a `..hidden` directory,
      // dropping the prefix and re-breaking every git badge there.
      expect(repoRelativePrefix('/repo', '/repo/..hidden/app')).toBe('..hidden/app/');
      // True escapes are still rejected, segment-aware.
      expect(repoRelativePrefix('/repo', '/repo/..')).toBe('');
      expect(repoRelativePrefix('/repo', '/repo/../other')).toBe('');
    });

    it('rev-parse prefix cache serves a fresh prefix after a project switch', async () => {
      // Regression (chimera perf fold): currentRepoPrefix caches the
      // rev-parse toplevel per RESOLVED projectRoot. The correctness
      // property is that a project SWITCH resolves fresh — if the cache
      // keyed on anything coarser (or leaked across entries), project B
      // would be served project A's 'packages/webui/' prefix and reject
      // its own paths as outside the project root. The return trip to A
      // then proves the still-valid A entry survives (hit stays correct).
      const sub2 = path.join(repo, 'packages', 'beta');
      fsSync.mkdirSync(sub2, { recursive: true });
      fsSync.writeFileSync(path.join(sub2, 'other.ts'), 'export const b = 1;\n');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'beta baseline']);
      fsSync.writeFileSync(path.join(sub2, 'other.ts'), 'export const b = 2;\n');

      const sub2Staged = (): string => {
        const out = execFileSync('git', ['status', '--porcelain'], {
          cwd: sub2,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        const line = out
          .split('\n')
          .find((l) => l.replace(/\\/g, '/').includes('packages/beta/other.ts'));
        return line?.slice(0, 2) ?? '';
      };

      // The beta commit above also committed the beforeEach's v = 2
      // working-tree change of index.ts, leaving it clean. Re-modify so
      // step 1 stages a REAL change (a clean file stages as a no-op and
      // porcelain has no line to assert on).
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 3;\n');

      // 1) Warm project A's (packages/webui) cache entry.
      const wsA = createMockWs();
      await handleGitStage(wsA, sub, ['packages/webui/index.ts']);
      expect(wsA.sent.find((m) => m.type === 'git.action_result')?.payload.ok).toBe(true);
      expect(stagedState()).toBe('M ');

      // 2) Immediately act on project B (packages/beta): a stale A prefix
      //    would reject 'packages/beta/other.ts' as outside the project.
      const wsB = createMockWs();
      await handleGitStage(wsB, sub2, ['packages/beta/other.ts']);
      expect(wsB.sent.find((m) => m.type === 'git.action_result')?.payload.ok).toBe(true);
      expect(sub2Staged()).toBe('M ');

      // 3) Return trip to A — its cache entry is still valid and correct.
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 11;\n');
      const wsA2 = createMockWs();
      await handleGitUnstage(wsA2, sub, ['packages/webui/index.ts']);
      expect(wsA2.sent.find((m) => m.type === 'git.action_result')?.payload.ok).toBe(true);
      expect(stagedState()).toBe(' M');
    });

    it('git diff accepts a legal double-dot filename', async () => {
      fsSync.writeFileSync(path.join(repo, 'release..notes.md'), 'v1\n');
      git(repo, ['add', 'release..notes.md']);
      git(repo, ['commit', '-q', '-m', 'notes baseline']);
      fsSync.writeFileSync(path.join(repo, 'release..notes.md'), 'v2\n');
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'release..notes.md');
      const p = ws.sent[0]?.payload as { oldText: string; newText: string; error?: string };
      expect(p.error).toBeUndefined();
      expect(p.oldText).toBe('v1\n');
      expect(p.newText).toBe('v2\n');
    });

    it('commit from a subdirectory project commits only the subdirectory', async () => {
      // Regression (chimera round-2): bare `git commit -m` from a
      // subdirectory cwd commits the ENTIRE repo's staged index since
      // Git 2.0 — staging one file outside the project and committing
      // inside it used to leak the outside file into the commit.
      fsSync.writeFileSync(path.join(sub, 'index.ts'), 'export const v = 5;\n');
      // Stage a MODIFIED file OUTSIDE the subdirectory project — staging
      // an unmodified file would be a no-op and prove nothing.
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nSTAGED OUTSIDE\n');
      git(repo, ['add', 'keep.txt']);
      const wsPrep = createMockWs();
      await handleGitStage(wsPrep, sub, ['packages/webui/index.ts']);
      const ws = createMockWs();
      await handleGitCommit(ws, sub, 'subdir-only commit');
      const result = ws.sent.find((m) => m.type === 'git.action_result');
      expect(result?.payload.ok).toBe(true);
      // The commit contains ONLY the sub project's file: keep.txt remains
      // staged for a future commit (not consumed by this one). It is a
      // TRACKED file, so staged-but-uncommitted shows as `M ` (X=M, Y=' ').
      const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
        cwd: sub,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
        .replace(/\\/g, '/');
      expect(committed).toBe('packages/webui/index.ts');
      const rootOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      expect(rootOut).toContain('M  keep.txt');
    });
  });

  describe('handleGitDiff', () => {
    it('returns HEAD text as oldText and working text as newText for a modified file', async () => {
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'line1\nNEW\nline3\n');
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'keep.txt');

      const p = ws.sent[0]?.payload as { oldText: string; newText: string };
      expect(ws.sent[0]?.type).toBe('git.diff');
      expect(p.oldText).toBe('line1\nline2\nline3\n');
      expect(p.newText).toBe('line1\nNEW\nline3\n');
    });

    it('returns empty oldText for an untracked file', async () => {
      fsSync.writeFileSync(path.join(repo, 'fresh.txt'), 'brand new\n');
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'fresh.txt');
      const p = ws.sent[0]?.payload as { oldText: string; newText: string };
      expect(p.oldText).toBe('');
      expect(p.newText).toBe('brand new\n');
    });

    it('returns empty newText for a deleted file', async () => {
      fsSync.rmSync(path.join(repo, 'gone.txt'));
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'gone.txt');
      const p = ws.sent[0]?.payload as { oldText: string; newText: string };
      expect(p.oldText).toBe('remove me\n');
      expect(p.newText).toBe('');
    });

    it('rejects path traversal', async () => {
      const ws = createMockWs();
      await handleGitDiff(ws, repo, '../escape.txt');
      const p = ws.sent[0]?.payload as { error?: string };
      expect(p.error).toBe('invalid path');
    });

    it('rejects absolute paths', async () => {
      const ws = createMockWs();
      await handleGitDiff(ws, repo, path.resolve(repo, 'keep.txt'));
      const p = ws.sent[0]?.payload as { error?: string };
      expect(p.error).toBe('invalid path');
    });

    it('rejects a working-tree symlink that escapes the project root', async () => {
      const outside = fsSync.mkdtempSync(
        path.join(process.env.TEMP || '/tmp', `gittest-out-${randomBytes(4).toString('hex')}`),
      );
      fsSync.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
      const link = path.join(repo, 'escape-link.txt');
      try {
        fsSync.symlinkSync(path.join(outside, 'secret.txt'), link);
      } catch {
        fsSync.rmSync(outside, { recursive: true, force: true });
        return;
      }
      try {
        const ws = createMockWs();
        await handleGitDiff(ws, repo, 'escape-link.txt');
        const p = ws.sent[0]?.payload as { error?: string; newText?: string };
        expect(p.error).toBe('path outside project root');
        expect(p.newText ?? '').not.toContain('nope');
      } finally {
        fsSync.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('flags a binary file', async () => {
      fsSync.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'bin.dat');
      const p = ws.sent[0]?.payload as { binary?: boolean };
      expect(p.binary).toBe(true);
    });
  });

  describe('handleGitStage & handleGitUnstage', () => {
    it('stages specific files and unstages them', async () => {
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'modified content\n');
      const ws = createMockWs();

      await handleGitStage(ws, repo, ['keep.txt']);
      const stageResult = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(stageResult).toMatchObject({ action: 'stage', ok: true });

      const changesAfterStage = ws.sent.find((m) => m.type === 'git.changes')?.payload as { files: Array<{ path: string; staged: boolean }> };
      expect(changesAfterStage.files.find((f) => f.path === 'keep.txt')?.staged).toBe(true);

      // Now unstage
      const ws2 = createMockWs();
      await handleGitUnstage(ws2, repo, ['keep.txt']);
      const unstageResult = ws2.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(unstageResult).toMatchObject({ action: 'unstage', ok: true });

      const changesAfterUnstage = ws2.sent.find((m) => m.type === 'git.changes')?.payload as { files: Array<{ path: string; staged: boolean }> };
      expect(changesAfterUnstage.files.find((f) => f.path === 'keep.txt')?.staged).toBe(false);
    });

    it('rejects unsafe path traversal during staging', async () => {
      const ws = createMockWs();
      await handleGitStage(ws, repo, ['../outside.txt']);
      const stageResult = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(stageResult).toMatchObject({ action: 'stage', ok: false });
    });
  });

  describe('handleGitDiscard', () => {
    it('discards modified tracked files', async () => {
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'modified content\n');
      const ws = createMockWs();
      await handleGitDiscard(ws, repo, ['keep.txt']);
      const res = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(res).toMatchObject({ action: 'discard', ok: true });
      expect(fsSync.readFileSync(path.join(repo, 'keep.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('line1\nline2\nline3\n');
    });

    it('discards untracked files', async () => {
      fsSync.writeFileSync(path.join(repo, 'untracked.txt'), 'hello\n');
      const ws = createMockWs();
      await handleGitDiscard(ws, repo, ['untracked.txt']);
      const res = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(res).toMatchObject({ action: 'discard', ok: true });
      expect(fsSync.existsSync(path.join(repo, 'untracked.txt'))).toBe(false);
    });
  });

  describe('handleGitCommit', () => {
    it('commits staged changes with a message', async () => {
      fsSync.writeFileSync(path.join(repo, 'keep.txt'), 'committed change\n');
      git(repo, ['add', 'keep.txt']);
      const ws = createMockWs();
      await handleGitCommit(ws, repo, 'feat: updated keep.txt');
      const res = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(res).toMatchObject({ action: 'commit', ok: true, message: 'feat: updated keep.txt' });

      // Clean tree after commit
      const changesAfterCommit = ws.sent.find((m) => m.type === 'git.changes')?.payload as { files: unknown[] };
      expect(changesAfterCommit.files).toHaveLength(0);
    });

    it('rejects empty commit message', async () => {
      const ws = createMockWs();
      await handleGitCommit(ws, repo, '   ');
      const res = ws.sent.find((m) => m.type === 'git.action_result')?.payload;
      expect(res).toMatchObject({ action: 'commit', ok: false });
    });
  });
});
