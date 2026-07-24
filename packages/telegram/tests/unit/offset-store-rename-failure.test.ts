import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ unlink: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: () => {
      throw new Error('rename failed');
    },
    unlinkSync: (file: fs.PathLike) => {
      if (failures.unlink) throw new Error('unlink failed');
      return actual.unlinkSync(file);
    },
  };
});

import { OffsetStore } from '../../src/offset-store.js';

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offset-rename-failure-'));
  file = path.join(root, 'offset.json');
  failures.unlink = false;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OffsetStore rename cleanup', () => {
  it('removes the temporary file when atomic rename fails', () => {
    new OffsetStore({ path: file }).write(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('tolerates a temporary-file cleanup failure', () => {
    failures.unlink = true;
    expect(() => new OffsetStore({ path: file }).write(1)).not.toThrow();
    expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(true);
  });
});
