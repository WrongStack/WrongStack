import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_PAGE_SIZE,
  HistoryArchive,
  historyArchivePath,
  MAX_MEMORY_ENTRIES,
} from '../src/history-archive.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-history-archive-'));
  directories.push(directory);
  return directory;
}

describe('HistoryArchive', () => {
  it('exports stable retention and paging limits', () => {
    expect(MAX_MEMORY_ENTRIES).toBe(150);
    expect(ARCHIVE_PAGE_SIZE).toBe(100);
    expect(historyArchivePath('C:/sessions/one')).toBe(
      path.join('C:/sessions/one', 'history-archive.jsonl'),
    );
  });

  it('appends, indexes, clamps, pages, and closes archived entries', async () => {
    const directory = await temporaryDirectory();
    const archive = new HistoryArchive(directory);
    archive.append({ id: 1, kind: 'user', text: 'first' });
    archive.append({ id: 2, kind: 'assistant', text: 'second' });
    archive.append({ id: 3, kind: 'info', text: 'third' });

    await archive.close();

    const reader = new HistoryArchive(directory);
    await expect(reader.loadRange(-5, 2)).resolves.toEqual([
      { id: 1, kind: 'user', text: 'first' },
      { id: 2, kind: 'assistant', text: 'second' },
    ]);
    expect(reader.archivedCount).toBe(3);
    await expect(reader.loadRange(2, 10)).resolves.toEqual([
      { id: 3, kind: 'info', text: 'third' },
    ]);
    await expect(reader.loadRange(10, 1)).resolves.toEqual([]);
    await expect(reader.loadRange(0, 0)).resolves.toEqual([]);

    await reader.close();
    await reader.close();
    reader.append({ id: 4, kind: 'warn', text: 'ignored after close' });
    await expect(reader.loadRange(0, 1)).resolves.toEqual([]);
  });

  it('skips blank and corrupt JSONL records while preserving valid entries', async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(
      historyArchivePath(directory),
      ['', '{"id":1,"kind":"user","text":"valid"}', '{invalid-json}', ''].join('\n'),
    );
    const archive = new HistoryArchive(directory);

    await expect(archive.loadRange(0, 10)).resolves.toEqual([
      { id: 1, kind: 'user', text: 'valid' },
    ]);
    expect(archive.archivedCount).toBe(2);
    await archive.close();
  });

  it('handles an empty archive and reuses the cached index and file handle', async () => {
    const directory = await temporaryDirectory();
    const archive = new HistoryArchive(directory);

    await expect(archive.loadRange(0, 10)).resolves.toEqual([]);
    await expect(archive.loadRange(0, 10)).resolves.toEqual([]);
    expect(archive.archivedCount).toBe(0);
    await archive.close();
  });

  it('contains append and close failures', async () => {
    const directory = await temporaryDirectory();
    const blockedPath = path.join(directory, 'not-a-directory');
    await fs.writeFile(blockedPath, 'file');
    const archive = new HistoryArchive(blockedPath);
    archive.append({ id: 1, kind: 'error', text: 'lost' });
    await expect(archive.close()).resolves.toBeUndefined();

    const second = new HistoryArchive(await temporaryDirectory());
    await second.loadRange(0, 1);
    const handle = (second as unknown as { handle: { close(): Promise<void> } }).handle;
    handle.close = vi.fn().mockRejectedValueOnce(new Error('already closed'));
    await expect(second.close()).resolves.toBeUndefined();
  });
});
