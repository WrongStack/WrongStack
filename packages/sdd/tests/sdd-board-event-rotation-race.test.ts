import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SddBoardStore } from '../src/sdd-board-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    appendFile: vi.fn(actual.appendFile),
    open: vi.fn(actual.open),
  };
});
const realRename = vi.mocked(fs.rename).getMockImplementation()!;
const realAppend = vi.mocked(fs.appendFile).getMockImplementation()!;
const realOpen = vi.mocked(fs.open).getMockImplementation()!;

it.each([0, 512, 1024])(
  'preserves a second store append across rotation retaining %i bytes',
  async (keepBytes) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'board-rotation-race-'));
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const running: Promise<void>[] = [];
    try {
      const rotating = new SddBoardStore({
        baseDir: dir,
        eventMaxBytes: 1024,
        eventKeepBytes: keepBytes,
        eventSizeCheckEvery: 1,
      });
      const appending = new SddBoardStore({ baseDir: dir, eventSizeCheckEvery: 100 });
      const file = rotating.eventsPath('run');
      const lock = join(dir, '.run.events.jsonl.lock');
      await fs.writeFile(
        file,
        JSON.stringify({ ts: 1, type: 'prior', payload: 'x'.repeat(800) }) + '\n',
      );
      let held = false;
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to) === file && !held) {
          held = true;
          entered.resolve();
          await gate.promise;
        }
        return realRename(from, to);
      });
      vi.mocked(fs.appendFile).mockImplementation(async (path, data, options) => {
        await realAppend(path, data, options);
        if (String(path) === file && String(data).includes('"type":"late"')) gate.resolve();
      });
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        try {
          return await realOpen(path, flags, mode);
        } catch (error) {
          // Either the append lands before replacement (the bug), or the writer
          // reaches the held lock and must append after replacement (the fix).
          if (String(path) === lock && (error as NodeJS.ErrnoException).code === 'EEXIST')
            gate.resolve();
          throw error;
        }
      });
      running.push(
        rotating.appendEvent('run', { ts: 2, type: 'rotate', payload: 'r'.repeat(300) }),
      );
      await entered.promise;
      running.push(appending.appendEvent('run', { ts: 3, type: 'late' }));
      await Promise.all(running);
      const types = (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).type);
      expect(types).toEqual(keepBytes === 0 ? ['late'] : ['rotate', 'late']);
    } finally {
      gate.resolve();
      await Promise.allSettled(running);
      vi.mocked(fs.rename).mockImplementation(realRename);
      vi.mocked(fs.appendFile).mockImplementation(realAppend);
      vi.mocked(fs.open).mockImplementation(realOpen);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
