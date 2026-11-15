import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultPathResolver } from '../../src/infrastructure/path-resolver.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('DefaultPathResolver non-existent target under symlinked directory (F369)', () => {
  it('rejects a non-existent file inside a directory symlink pointing outside projectRoot', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f369-'));
    temps.push(tmp);
    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const resolver = new DefaultPathResolver(root, root);
    expect(() => resolver.ensureInsideRoot('escape/new-secret.txt')).toThrow(
      'outside the project root',
    );
  });
});
