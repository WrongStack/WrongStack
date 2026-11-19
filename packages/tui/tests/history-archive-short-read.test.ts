import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryArchive, historyArchivePath } from '../src/history-archive.js';
import type { HistoryEntry } from '../src/history-entry.js';

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, open: vi.fn(real.open) };
});

const entries = [
  { id: 1, kind: 'user', text: 'before' },
  { id: 2, kind: 'assistant', text: 'café ☕' },
] as const satisfies readonly HistoryEntry[];
const firstLine = `${JSON.stringify(entries[0])}\n`;
const secondLine = `${JSON.stringify(entries[1])}\n`;
let directory: string;
let archive: HistoryArchive;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-archive-read-'));
  archive = new HistoryArchive(directory);
  await fs.writeFile(historyArchivePath(directory), `${firstLine}${secondLine}`);
});

afterEach(async () => {
  vi.mocked(fs.open).mockReset();
  await archive.close();
  await fs.rm(directory, { recursive: true, force: true });
});

it.each([
  ['control: full reads', false],
  ['short reads: complete records remain visible in order', true],
] as const)('%s', async (_case, shortReads) => {
  if (shortReads) {
    const { open } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      const read = handle.read.bind(handle);
      return Object.assign(handle, {
        read: (buffer: Buffer, offset: number, length: number, position: number) => {
          // Make the buffer's unread tail deterministic, regardless of allocUnsafe's contents.
          buffer.fill(0, offset, offset + length);
          return read(buffer, offset, Math.min(7, length), position);
        },
      });
    });
  }
  await expect(archive.loadRange(0, 2)).resolves.toEqual(entries);
  expect(archive.archivedCount).toBe(2);
});

it('keeps the complete record when EOF interrupts the next indexed record', async () => {
  await expect(archive.loadRange(0, 2)).resolves.toEqual(entries);
  await fs.truncate(historyArchivePath(directory), Buffer.byteLength(firstLine) + 7);
  await expect(archive.loadRange(0, 2)).resolves.toEqual(entries.slice(0, 1));
});
