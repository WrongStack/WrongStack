import { watch } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

it('copies every item or none of them and leaves no hidden copy behind', async () => {
  await writeFile(join(dir, 'lib', 'b.ts'), 'existing');
  const refused = await call('files.copy_many', {
    items: [
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'src/b.ts', to: 'lib/b.ts' },
    ],
  });
  expect(refused).toMatchObject({ type: 'files.copied_many', payload: { success: false } });
  expect(await listing('lib')).toEqual(['b.ts']);
  for (const items of [
    [{ from: 'full', to: 'full/inner' }],
    [
      { from: 'src/a.ts', to: 'lib/x.ts' },
      { from: 'src/c.ts', to: 'lib/x.ts' },
    ],
    [
      { from: 'src/a.ts', to: 'full/a.ts' },
      { from: 'full', to: 'lib/full' },
    ],
  ])
    expect((await call('files.copy_many', { items })).payload.success).toBe(false);

  const copied = await call('files.copy_many', {
    items: [
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'full', to: 'lib/full' },
    ],
  });
  expect(copied.payload).toMatchObject({ success: true });
  expect(await listing('lib')).toEqual(['a.ts', 'b.ts', 'full']);
  expect(await readFile(join(dir, 'lib', 'full', 'keep.txt'), 'utf8')).toBe('keep');
  expect(await listing('src')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(await listing('full')).toEqual(['keep.txt']);
});

it('refuses to copy a folder that contains a link', async () => {
  await symlink(join(dir, 'src'), join(dir, 'full', 'link'), 'junction');
  const refused = await call('files.copy_many', { items: [{ from: 'full', to: 'lib/full' }] });
  expect(refused.payload).toMatchObject({ success: false, error: expect.stringMatching(/link/) });
  expect(await listing('lib')).toEqual([]);
});

// Windows refuses to rename a folder while any file inside it is open, and reports EPERM. A
// watcher, the search indexer or antivirus opening a freshly copied file is enough, so a copy
// must wait out such a short-lived handle instead of failing the whole batch.
it.runIf(process.platform === 'win32')(
  'copies a folder while another process briefly holds a file in the copy open',
  async () => {
    for (let index = 0; index < 20; index++)
      await writeFile(join(dir, 'full', `f${index}.txt`), `file ${index}`);
    const held: Promise<void>[] = [];
    const watcher = watch(join(dir, 'lib'), { recursive: true }, (_event, name) => {
      const file = String(name ?? '');
      if (!file.startsWith('.wrongstack-copy-') || !file.endsWith('keep.txt') || held.length)
        return;
      held.push(
        open(join(dir, 'lib', file), 'r')
          .then(async (handle) => {
            await new Promise((done) => setTimeout(done, 600));
            await handle.close();
          })
          .catch(() => undefined),
      );
    });
    try {
      const copied = await call('files.copy_many', { items: [{ from: 'full', to: 'lib/full' }] });
      expect(held).toHaveLength(1);
      expect(copied.payload['error']).toBeUndefined();
      expect(copied.payload).toMatchObject({ success: true });
      expect(await listing('lib/full')).toHaveLength(21);
      expect((await listing('lib')).filter((name) => name.startsWith('.wrongstack-copy-'))).toEqual(
        [],
      );
    } finally {
      watcher.close();
      await Promise.all(held);
    }
  },
);
