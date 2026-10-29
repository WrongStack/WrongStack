import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type ContentRouteContext, handleContentRoute } from '../src/server/content-routes.js';

let dir = '';
const base = resolve(tmpdir());
beforeEach(async () => {
  dir = await mkdtemp(join(base, 'file-batch-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'lib'));
  await mkdir(join(dir, 'full'));
  for (const name of ['a.ts', 'b.ts', 'c.ts']) await writeFile(join(dir, 'src', name), name);
  await writeFile(join(dir, 'full', 'keep.txt'), 'keep');
});
afterEach(async () => {
  expect(dir.startsWith(base + sep)).toBe(true);
  await rm(dir, { recursive: true, force: true });
});

async function call(type: string, payload: Record<string, unknown>) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const context = {
    getProjectRoot: () => dir,
    getDesignContext: () => ({ projectRoot: dir }),
    getSkillsContext: () => {
      throw Error('Not skills');
    },
    getPromptsContext: () => {
      throw Error('Not prompts');
    },
  } satisfies ContentRouteContext;
  const socket = { readyState: 1, send: (message: string) => sent.push(JSON.parse(message)) };
  expect(
    await handleContentRoute(context, socket as unknown as WebSocket, { type, payload } as never),
  ).toBe(true);
  return sent.at(-1)!;
}

const listing = async (folder: string) => (await readdir(join(dir, folder))).sort();

it('moves every item or none of them', async () => {
  // The last target exists, so the whole batch is refused before anything moves.
  await writeFile(join(dir, 'lib', 'c.ts'), 'taken');
  const refused = await call('files.move_many', {
    items: [
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'src/b.ts', to: 'lib/renamed.ts' },
      { from: 'src/c.ts', to: 'lib/c.ts' },
    ],
  });
  expect(refused).toMatchObject({ type: 'files.moved_many', payload: { success: false } });
  expect(await listing('src')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(await listing('lib')).toEqual(['c.ts']);

  for (const items of [
    [{ from: 'src', to: 'src/inner' }],
    [
      { from: 'src/a.ts', to: 'lib/x.ts' },
      { from: 'src/b.ts', to: 'lib/x.ts' },
    ],
    [{ from: '../outside', to: 'lib/x.ts' }],
    [{ from: '.', to: 'lib/root' }],
  ])
    expect((await call('files.move_many', { items })).payload.success).toBe(false);

  const moved = await call('files.move_many', {
    items: [
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'src/b.ts', to: 'lib/renamed.ts' },
    ],
  });
  expect(moved.payload).toMatchObject({ success: true });
  expect(await listing('src')).toEqual(['c.ts']);
  expect(await readFile(join(dir, 'lib', 'renamed.ts'), 'utf8')).toBe('b.ts');
});

it('deletes every item or none of them and leaves no staging folder', async () => {
  const refused = await call('files.delete_many', { filePaths: ['src/a.ts', 'full'] });
  expect(refused).toMatchObject({ type: 'files.deleted_many', payload: { success: false } });
  expect(await listing('src')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(
    (await call('files.delete_many', { filePaths: ['src', 'src/a.ts'] })).payload.success,
  ).toBe(false);

  const deleted = await call('files.delete_many', {
    filePaths: ['src/a.ts', 'full'],
    recursive: true,
  });
  expect(deleted.payload).toMatchObject({ success: true });
  expect(deleted.payload).not.toHaveProperty('warning');
  expect(await listing('src')).toEqual(['b.ts', 'c.ts']);
  expect(await listing('.')).toEqual(['lib', 'src']);
});
