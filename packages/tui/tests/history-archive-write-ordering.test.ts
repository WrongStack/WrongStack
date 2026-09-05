/**
 * Regression: `loadRange` built its index without ordering against the
 * pending write chain, so a page requested right after fire-and-forget
 * `append()` calls could resolve empty/short — the scroll hook then advanced
 * its cursor past lines that were never served (permanent skip).
 * loadRange now awaits `writeChain` before building the index.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryArchive } from '../src/history-archive.js';
import type { HistoryEntry } from '../src/history-entry.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-archive-ordering-'));
  directories.push(directory);
  return directory;
}

function entry(id: number): HistoryEntry {
  return { id, kind: 'info', text: `entry-${id}-${'x'.repeat(512 * 1024)}` };
}

describe('HistoryArchive write ordering', () => {
  it('serves the full page while large appends are still queued', async () => {
    const directory = await temporaryDirectory();
    const archive = new HistoryArchive(directory);
    for (let id = 0; id < 10; id++) archive.append(entry(id));

    // No settling: the load must order against the queued writes itself.
    const page = await archive.loadRange(0, 10);
    await archive.close();

    expect(page.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('awaits a batch queued while a previous page was loading', async () => {
    const directory = await temporaryDirectory();
    const archive = new HistoryArchive(directory);
    for (let id = 0; id < 5; id++) archive.append({ id, kind: 'info', text: `entry-${id}` });

    await archive.loadRange(0, 5); // flushes the first batch

    for (let id = 5; id < 10; id++) archive.append({ id, kind: 'info', text: `entry-${id}` });
    const page = await archive.loadRange(0, 10);
    await archive.close();

    expect(page.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
