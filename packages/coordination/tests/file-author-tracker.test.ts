import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compactLog,
  type FileAuthorTrackerOptions,
  getFileHistory,
  getFilesByAgent,
  getFullLog,
  getLastAuthor,
  recordFileAction,
} from '../src/file-author-tracker.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

describe('file-author-tracker', () => {
  let tmpDir: string;
  let opts: FileAuthorTrackerOptions;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fat-test-'));
    opts = { storageDir: tmpDir, projectRoot: '/fake/project' };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(['', '{"entries":[', '{"entries":[]}\ntrailing', 'null', '{}', '{"entries":"bad"}'])(
    'preserves malformed logs before recording a new action (%j)',
    async (raw) => {
      await fs.writeFile(path.join(tmpDir, 'file-authors.json'), raw);

      await recordFileAction(opts, { filePath: 'package.json', action: 'edit', agentId: 'leader' });

      expect(await getLastAuthor(opts, 'package.json')).toMatchObject({ agentId: 'leader' });
      const backups = (await fs.readdir(tmpDir)).filter((name) =>
        name.startsWith('file-authors.json.corrupt-'),
      );
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(tmpDir, backups[0] ?? ''), 'utf8')).toBe(raw);
      await recordFileAction(opts, { filePath: 'other.ts', action: 'create', agentId: 'leader' });
      expect((await getFullLog(opts)).entries).toHaveLength(2);
      expect(
        (await fs.readdir(tmpDir)).filter((name) => name.startsWith('file-authors.json.corrupt-')),
      ).toHaveLength(1);
    },
  );

  it('preserves the original and rejects when the corruption backup fails', async () => {
    const source = path.join(tmpDir, 'file-authors.json');
    const raw = '{"entries":[';
    await fs.writeFile(source, raw);
    const failure = new Error('backup unavailable');
    const copy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(failure);
    try {
      await expect(
        recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'leader' }),
      ).rejects.toBe(failure);
      expect(await fs.readFile(source, 'utf8')).toBe(raw);
    } finally {
      copy.mockRestore();
    }
  });

  it('does not replace a log that cannot be read', async () => {
    await fs.mkdir(path.join(tmpDir, 'file-authors.json'));
    await expect(
      recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'leader' }),
    ).rejects.toThrow();
    expect((await fs.stat(path.join(tmpDir, 'file-authors.json'))).isDirectory()).toBe(true);
  });

  it('records a create action and retrieves it', async () => {
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'create',
      agentId: 'leader',
      agentName: 'Leader',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last).toBeDefined();
    expect(last!.action).toBe('create');
    expect(last!.agentId).toBe('leader');
    expect(last!.filePath).toBe('src/index.ts');
  });

  it('records multiple actions and returns the latest', async () => {
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'create',
      agentId: 'leader',
    });
    await recordFileAction(opts, {
      filePath: 'src/index.ts',
      action: 'edit',
      agentId: 'tech-stack',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last!.action).toBe('edit');
    expect(last!.agentId).toBe('tech-stack');
  });

  it('returns file history in order', async () => {
    await recordFileAction(opts, { filePath: 'a.ts', action: 'create', agentId: 'x' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'y' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'z' });

    const history = await getFileHistory(opts, 'a.ts');
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.agentId)).toEqual(['x', 'y', 'z']);
  });

  it('getFilesByAgent returns latest per file', async () => {
    await recordFileAction(opts, { filePath: 'a.ts', action: 'create', agentId: 'leader' });
    await recordFileAction(opts, { filePath: 'b.ts', action: 'create', agentId: 'leader' });
    await recordFileAction(opts, { filePath: 'a.ts', action: 'edit', agentId: 'tech-stack' });

    const map = await getFilesByAgent(opts, 'leader');
    // leader created a.ts and b.ts; tech-stack later edited a.ts
    // so leader's latest touch on a.ts is the create, b.ts is the create
    expect(map.size).toBe(2);
    expect(map.has('a.ts')).toBe(true); // leader's create
    expect(map.has('b.ts')).toBe(true); // leader's create
    expect(map.get('a.ts')!.action).toBe('create');
  });

  it('compacts log and archives old entries', async () => {
    for (let i = 0; i < 10; i++) {
      await recordFileAction(opts, { filePath: `f${i}.ts`, action: 'create', agentId: 'x' });
    }

    const result = await compactLog(opts, 5);
    expect(result.archived).toBe(5);
    expect(result.kept).toBe(5);

    const log = await getFullLog(opts);
    expect(log.entries).toHaveLength(5);
    expect(log.lastCompactedAt).toBeDefined();
  });

  it('handles windows-style paths', async () => {
    await recordFileAction(opts, {
      filePath: 'src\\index.ts',
      action: 'create',
      agentId: 'leader',
    });

    const last = await getLastAuthor(opts, 'src/index.ts');
    expect(last).toBeDefined();
  });

  it('keeps every record when records overlap (parallel tool calls)', async () => {
    // Recorded fire-and-forget per write/edit tool call; an unlocked
    // read-modify-write let overlapping records drop each other.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        recordFileAction(opts, { filePath: `src/f${i}.ts`, action: 'edit', agentId: 'leader' }),
      ),
    );
    expect((await getFullLog(opts)).entries).toHaveLength(20);
  });
});
