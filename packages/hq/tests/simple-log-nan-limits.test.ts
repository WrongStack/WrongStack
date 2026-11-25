import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqSimpleLog } from '../src/persistence/simple-log.js';

describe('HqSimpleLog non-finite option bounds', () => {
  it('falls back to Infinity instead of wiping the log when maxLines/rotateKeep/readLimit are NaN', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f1920-test-'));
    try {
      const log = new HqSimpleLog<{ id: number }>({
        dataDir: dir,
        filename: 'bad.jsonl',
        maxLines: Number.NaN,
        rotateKeep: Number.NaN,
        readLimit: Number.NaN,
      });
      log.append({ id: 1 });
      log.append({ id: 2 });
      await log.drain();
      expect(await log.readAll()).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
