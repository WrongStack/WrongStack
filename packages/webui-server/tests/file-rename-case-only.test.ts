import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleFilesRename } from '../src/server/file-handler-mutations.js';

/**
 * F1393: on a case-insensitive filesystem a case-only rename (`readme.md` ->
 * `README.md`) was refused — the destination "existed" only because it is the
 * source itself ("Destination already exists."; for a folder "Cannot rename a
 * directory into itself."). The File Explorer's rename prompt sends exactly that.
 */

async function rename(root: string, oldPath: string, newPath: string) {
  const frames: Array<{ payload: Record<string, unknown> }> = [];
  const ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)) };
  await handleFilesRename(
    ws as unknown as WebSocket,
    { type: 'files.rename', payload: { oldPath, newPath } },
    root,
  );
  return frames[0]!.payload;
}

describe('files.rename — case-only rename (F1393)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rename-case-'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'keep.md'), 'k');
    fs.writeFileSync(path.join(root, 'readme.md'), 'hello');
    fs.writeFileSync(path.join(root, 'other.md'), 'o');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // On a case-sensitive filesystem this is an ordinary rename; the expectations are the same.
  it('renames a file and a folder to a new case', async () => {
    expect(await rename(root, 'readme.md', 'README.md')).toMatchObject({ success: true });
    expect(await rename(root, 'docs', 'Docs')).toMatchObject({ success: true });
    const names = fs.readdirSync(root);
    expect(names).toEqual(expect.arrayContaining(['README.md', 'Docs', 'other.md']));
    expect(names).not.toContain('readme.md');
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(root, 'Docs', 'keep.md'), 'utf8')).toBe('k');
  });

  it('still refuses a different existing destination and an identical name', async () => {
    expect(await rename(root, 'readme.md', 'other.md')).toMatchObject({
      success: false,
      error: 'Destination already exists.',
    });
    expect(await rename(root, 'readme.md', 'readme.md')).toMatchObject({ success: false });
    expect(await rename(root, 'docs', 'docs/inner')).toMatchObject({
      success: false,
      error: 'Cannot rename a directory into itself.',
    });
    expect(fs.readFileSync(path.join(root, 'other.md'), 'utf8')).toBe('o');
  });
});
