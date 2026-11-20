/**
 * #444: `edit` refused a file as "modified externally" for good once something
 * other than `edit` wrote it, when the only record was a tool's own write.
 * The WrongForge leader route runs `wstack_*` calls in the session's Context
 * but offers no `read`, so nothing the leader could do refreshed the record.
 *
 * Real Context and real tools; the out-of-band write stands in for a
 * formatter or `sed -i` run through `bash`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context } from '@wrongstack/core/agent';
import { afterAll, describe, expect, it } from 'vitest';
import { editTool } from '../src/edit.js';
import { readTool } from '../src/read.js';
import { writeTool } from '../src/write.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

async function session(): Promise<{ ctx: Context; file: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'edit-stale-')));
  dirs.push(dir);
  const ctx = new Context({
    systemPrompt: [],
    provider: null as never,
    session: { id: 's' } as never,
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: dir,
    projectRoot: dir,
    model: 'test',
  });
  return { ctx, file: path.join(dir, 'a.ts') };
}
const opts = () => ({ signal: new AbortController().signal });
const edit = (ctx: Context, old_string: string, new_string: string) =>
  editTool.execute({ path: 'a.ts', old_string, new_string }, ctx, opts());

describe('edit staleness guard (#444)', () => {
  it('edits again after an out-of-band write when only its own write is recorded', async () => {
    const { ctx, file } = await session();
    await fs.writeFile(file, 'const a = 1;\nconst b = 2;\n');
    await edit(ctx, 'const a = 1;', 'const a = 10;');
    await fs.writeFile(file, 'const a = 10;\nconst b = 2; // fmt\n');

    const out = await edit(ctx, 'const b = 2;', 'const b = 20;');

    expect(out.replacements).toBe(1);
    expect(out.note).toMatch(/auto-read the current file/);
    expect(await fs.readFile(file, 'utf8')).toBe('const a = 10;\nconst b = 20; // fmt\n');
  });

  it('edits a file `write` created and a formatter then rewrote', async () => {
    const { ctx, file } = await session();
    await writeTool.execute({ path: 'a.ts', content: 'export const x = 1\n' }, ctx, opts());
    await fs.writeFile(file, 'export const x = 1;\n');

    expect((await edit(ctx, 'x = 1;', 'x = 2;')).replacements).toBe(1);
  });

  it('still refuses a file changed after a read, says what changed, and a ranged re-read clears it', async () => {
    const { ctx, file } = await session();
    await fs.writeFile(file, 'hello\nworld\n');
    await readTool.execute({ path: 'a.ts' }, ctx, opts());
    await fs.writeFile(file, 'hello, changed\nworld\n');

    const refused = await edit(ctx, 'hello', 'hi').catch((err: Error) => err);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(
      /modified externally: its content \(sha256 [0-9a-f]{12}\) differs from the last read \(sha256 [0-9a-f]{12}\)\..*a `read` of any range refreshes the record/,
    );

    await readTool.execute({ path: 'a.ts', offset: 2, limit: 1 }, ctx, opts());
    expect((await edit(ctx, 'hello', 'hi')).replacements).toBe(1);
  });

  it('a no-op edit of an unread file is not a read: no write bypass, no guard', async () => {
    const { ctx, file } = await session();
    await fs.writeFile(file, 'const a = 1;\n');

    expect((await edit(ctx, 'a = 1', 'a = 1')).replacements).toBe(0);
    // The permission policy auto-approves `write` for a file the model read.
    expect(ctx.hasRead(file)).toBe(false);

    await fs.writeFile(file, 'const a = 1; // fmt\n');
    expect((await edit(ctx, 'a = 1', 'a = 2')).replacements).toBe(1);
  });

  it('a suppressed re-read of restored content records that content, not the stale hash', async () => {
    const { ctx, file } = await session();
    await fs.writeFile(file, 'const v = 1;\n');
    const { atime, mtime } = await fs.stat(file);
    await readTool.execute({ path: 'a.ts' }, ctx, opts());
    await edit(ctx, 'v = 1', 'v = 2');
    // Restored out of band (git checkout, undo) with the size and mtime the
    // read saw, so the re-read is rightly answered as "unchanged".
    await fs.writeFile(file, 'const v = 1;\n');
    await fs.utimes(file, atime, mtime);

    expect((await readTool.execute({ path: 'a.ts' }, ctx, opts())).cached).toBe(true);
    expect((await edit(ctx, 'v = 1', 'v = 3')).replacements).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('const v = 3;\n');
  });
});
