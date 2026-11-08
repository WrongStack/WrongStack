import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileAuthorStorageDir,
  getFullLog,
  recordToolFileAuthor,
} from '../src/file-author-tracker.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options() {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'file-authors-'));
  dirs.push(storageDir);
  return { storageDir, projectRoot: '/project' };
}

describe('recording the leader’s file writes from tool.executed', () => {
  it('records successful write, edit, replace and patch calls with their session', async () => {
    const opts = options();
    await recordToolFileAuthor(opts, { name: 'write', ok: true, input: { path: 'a.ts' } }, 's1');
    await recordToolFileAuthor(opts, { name: 'edit', ok: true, input: { path: 'b.ts' } }, 's2');
    await recordToolFileAuthor(opts, { name: 'patch', ok: true, input: { path: 'c.ts' } }, 's2');
    const log = await getFullLog(opts);
    expect(
      log.entries.map(({ filePath, action, agentId, sessionId }) => ({
        filePath,
        action,
        agentId,
        sessionId,
      })),
    ).toEqual([
      { filePath: 'a.ts', action: 'create', agentId: 'leader', sessionId: 's1' },
      { filePath: 'b.ts', action: 'edit', agentId: 'leader', sessionId: 's2' },
      { filePath: 'c.ts', action: 'edit', agentId: 'leader', sessionId: 's2' },
    ]);
  });

  it('ignores failed calls, tools that write nothing and calls without a path', async () => {
    const opts = options();
    expect(
      recordToolFileAuthor(opts, { name: 'edit', ok: false, input: { path: 'a.ts' } }, 's'),
    ).toBeUndefined();
    expect(
      recordToolFileAuthor(opts, { name: 'read', ok: true, input: { path: 'a.ts' } }, 's'),
    ).toBeUndefined();
    expect(recordToolFileAuthor(opts, { name: 'write', ok: true, input: {} }, 's')).toBeUndefined();
    expect((await getFullLog(opts)).entries).toEqual([]);
  });

  it('keeps the log where the CLI keeps it', () => {
    expect(fileAuthorStorageDir({ globalRoot: '/home/u/.wrongstack', projectSlug: 'p-1' })).toBe(
      '/home/u/.wrongstack/projects/p-1',
    );
  });
});
