import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  onWatch: undefined as ((eventType: string, filename: string | Buffer | null) => void) | undefined,
  readFile: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    watch: vi.fn(
      (
        _root: string,
        _options: unknown,
        listener: (eventType: string, filename: string | Buffer | null) => void,
      ) => {
        io.onWatch = listener;
        return { on: vi.fn(), close: vi.fn(), unref: vi.fn() };
      },
    ),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  io.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: io.readFile };
});

import {
  ChronicleJournal,
  createChronicleContext,
  startChronicleFileObserver,
} from '../../src/chronicle/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  io.onWatch = undefined;
  io.readFile.mockClear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Chronicle file observer I/O', () => {
  it('reuses a complete full-scan fingerprint instead of reading every file twice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-io-'));
    tempDirs.push(root);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await writeFile(path.join(root, name), `export const ${name[0]} = 1;\n`);
    }
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 5,
      minFullRescanIntervalMs: 0,
    });
    expect(io.readFile.mock.calls.filter(([file]) => String(file).endsWith('.ts'))).toHaveLength(3);

    io.readFile.mockClear();
    await Promise.all([
      writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n'),
      writeFile(path.join(root, 'b.ts'), 'export const b = 2;\n'),
      writeFile(path.join(root, 'c.ts'), 'export const c = 2;\n'),
    ]);
    io.onWatch?.('change', null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await observer.close();

    expect(io.readFile.mock.calls.filter(([file]) => String(file).endsWith('.ts'))).toHaveLength(3);
    expect(journal.stats()).toMatchObject({ batches: 1, persistedEvents: 3, largestBatch: 3 });
  });

  it('rescans stat-only over unchanged files (hash reuse via size+mtime)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-io-'));
    tempDirs.push(root);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await writeFile(path.join(root, name), `export const ${name[0]} = 1;\n`);
    }
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 5,
      minFullRescanIntervalMs: 0,
    });
    io.readFile.mockClear();

    // Only a.ts changes; the rescan must re-read just that file — b.ts and
    // c.ts keep their size+mtime and reuse the known hash without a read.
    await writeFile(path.join(root, 'a.ts'), 'export const a = 22;\n');
    io.onWatch?.('change', null);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && journal.stats().persistedEvents < 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await observer.close();

    expect(io.readFile.mock.calls.filter(([file]) => String(file).endsWith('.ts'))).toHaveLength(1);
    expect(journal.stats().persistedEvents).toBe(1);
  });

  it('defers a null-filename rescan inside the min interval instead of dropping it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-io-'));
    tempDirs.push(root);
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'export const a = 1;\n');
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 5,
      minFullRescanIntervalMs: 500,
    });
    io.readFile.mockClear();

    // Change the size as well as the content so this timing test does not
    // depend on the filesystem exposing a distinct mtime tick under load.
    await writeFile(file, 'export const a = 22;\n');
    io.onWatch?.('change', null);
    // Inside the interval: the rescan is queued, not run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(io.readFile.mock.calls.filter(([f]) => String(f).endsWith('.ts'))).toHaveLength(0);

    // The queued rescan fires once the interval elapses and finds the change.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && journal.stats().persistedEvents < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await observer.close();
    expect(journal.stats().persistedEvents).toBe(1);
  });
});
