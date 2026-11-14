import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionRewinder } from '../../src/storage/session-rewinder.js';

// Covers the no-checkpoint / no-snapshot early returns of the rewind methods
// and revertSnapshots' outside-root skip + per-file error paths.

let tmp: string;
const ts = () => new Date().toISOString();

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-rewind-extra-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSession(events: object[]): Promise<string> {
  const id = 'sess';
  await fs.writeFile(
    path.join(tmp, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return id;
}

describe('session-rewinder — extra coverage', () => {
  it('rewindLastN returns an empty result when there are no checkpoints', async () => {
    const id = await writeSession([
      { type: 'session_start', ts: ts(), id: 's', model: 'm', provider: 'p' },
    ]);
    const rewind = new DefaultSessionRewinder(tmp, tmp);
    expect(await rewind.rewindLastN(id, 1)).toEqual({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
      removedEvents: 0,
    });
  });

  it('rewindToStart returns an empty result when there are no file snapshots', async () => {
    const id = await writeSession([
      { type: 'session_start', ts: ts(), id: 's', model: 'm', provider: 'p' },
      { type: 'checkpoint', ts: ts(), promptIndex: 0, promptPreview: 'p' },
    ]);
    const rewind = new DefaultSessionRewinder(tmp, tmp);
    expect(await rewind.rewindToStart(id)).toEqual({
      revertedFiles: [],
      errors: [],
      toPromptIndex: 0,
      removedEvents: 0,
    });
  });

  it('rewindToStart reverts in-root files, skips outside-root paths, and records per-file errors', async () => {
    const modPath = path.join(tmp, 'mod.ts');
    await fs.writeFile(modPath, 'changed', 'utf8'); // current content to be reverted
    const outsidePath = path.resolve(tmp, '..', 'rewind-outside-evil.ts');
    const createdPath = path.join(tmp, 'never-existed.ts');

    const id = await writeSession([
      { type: 'checkpoint', ts: ts(), promptIndex: 0, promptPreview: 'p' },
      {
        type: 'file_snapshot',
        ts: ts(),
        promptIndex: 1,
        files: [
          { path: modPath, action: 'modified', before: 'orig', after: 'changed' },
          { path: outsidePath, action: 'modified', before: 'x', after: 'y' }, // outside root → skipped
          { path: createdPath, action: 'created', before: null, after: 'new' }, // unlink ENOENT → error
        ],
      },
    ]);

    const rewind = new DefaultSessionRewinder(tmp, tmp);
    const result = await rewind.rewindToStart(id);

    expect(result.revertedFiles).toContain(modPath); // modified file restored to 'orig'
    expect(await fs.readFile(modPath, 'utf8')).toBe('orig');
    expect(result.errors.some((e) => e.includes('outside project root'))).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(2); // outside-root skip + created-unlink ENOENT
  });

  it('blocks rewind through a symlink/junction pointing outside project root (F212)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-f212-'));
    const projectRoot = path.join(tmp, 'proj');
    const outsideDir = path.join(tmp, 'outside');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    try {
      const secretFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(secretFile, 'ORIGINAL_SECRET', 'utf8');
      const linkDir = path.join(projectRoot, 'escape-dir');
      await fs.symlink(outsideDir, linkDir, 'junction');
      const targetViaLink = path.join(linkDir, 'secret.txt');

      const sessionPath = path.join(tmp, 's-f212.jsonl');
      await fs.writeFile(
        sessionPath,
        [
          JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z' }),
          JSON.stringify({
            type: 'checkpoint',
            ts: '2026-01-01T00:00:01Z',
            promptIndex: 0,
            promptPreview: 'p',
          }),
          JSON.stringify({
            type: 'file_snapshot',
            ts: '2026-01-01T00:00:02Z',
            promptIndex: 0,
            files: [{ path: targetViaLink, action: 'modified', before: 'OVERWRITTEN', after: '' }],
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const rewind = new DefaultSessionRewinder(tmp, projectRoot);
      const result = await rewind.rewindToCheckpoint('s-f212', 0);

      expect(await fs.readFile(secretFile, 'utf8')).toBe('ORIGINAL_SECRET');
      expect(result.errors.some((e) => e.includes('outside project root'))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
