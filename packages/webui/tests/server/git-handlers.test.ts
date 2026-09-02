import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleGitChanges, handleGitDiff } from '@wrongstack/webui-server';

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

    it('never throws outside a git repo', async () => {
      const notRepo = path.join(
        process.env.TEMP || '/tmp',
        `notgit-${randomBytes(4).toString('hex')}`,
      );
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

    it('flags a binary file', async () => {
      fsSync.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
      const ws = createMockWs();
      await handleGitDiff(ws, repo, 'bin.dat');
      const p = ws.sent[0]?.payload as { binary?: boolean };
      expect(p.binary).toBe(true);
    });
  });
});
