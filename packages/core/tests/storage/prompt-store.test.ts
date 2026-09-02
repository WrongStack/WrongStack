import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultPromptStore, migratePromptEntry } from '../../src/storage/prompt-store.js';
import { isUlid } from '../../src/utils/ulid.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

function makePaths(tmpDir: string) {
  return resolveWstackPaths({ projectRoot: tmpDir, globalRoot: tmpDir });
}

describe('DefaultPromptStore', () => {
  let tmpDir: string;
  let paths: ReturnType<typeof makePaths>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-store-'));
    paths = makePaths(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── createNew ──────────────────────────────────────────────────────────────

  describe('createNew', () => {
    it('returns an entry with a ULID id, title, content, slug and ISO timestamps', () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('My Prompt', 'hello world');
      expect(isUlid(entry.id)).toBe(true);
      expect(entry.title).toBe('My Prompt');
      expect(entry.content).toBe('hello world');
      expect(entry.tags).toEqual([]);
      expect(entry.slug).toBe('my-prompt');
      expect(entry.source).toBe('user');
      expect(entry.favorite).toBe(false);
      expect(entry.category).toBe('uncategorized');
      expect(entry.createdAt).toBe(entry.updatedAt);
      expect(new Date(entry.createdAt).toString()).not.toBe('Invalid Date');
    });

    it('accepts structured extra fields (category, description, source, variables)', () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Bug Hunt', 'find {{thing}}', ['debug'], {
        category: 'debugging',
        description: 'Hunt for bugs',
        source: 'builtin',
        variables: [{ name: 'thing', required: true }],
      });
      expect(entry.category).toBe('debugging');
      expect(entry.description).toBe('Hunt for bugs');
      expect(entry.source).toBe('builtin');
      expect(entry.variables).toEqual([{ name: 'thing', required: true }]);
    });

    it('accepts optional tags', () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('T', 'c', ['tag1', 'tag2']);
      expect(entry.tags).toEqual(['tag1', 'tag2']);
    });

    it('does NOT persist — list() returns empty before save()', async () => {
      const store = new DefaultPromptStore(paths);
      store.createNew('Unlisted', 'should not appear');
      await expect(store.list()).resolves.toEqual([]);
    });
  });

  // ── save ────────────────────────────────────────────────────────────────────

  describe('save', () => {
    it('writes an <id>.json file wrapped in { version: 2, entry }', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Save Me', 'content here');
      await store.save(entry);

      const raw = JSON.parse(
        await fs.readFile(path.join(paths.globalPrompts, `${entry.id}.json`), 'utf8'),
      );
      expect(raw).toEqual({ version: 2, entry });
    });

    it('overwrites an existing entry for the same id', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Overwrite Me', 'v1');
      await store.save(entry);

      entry.content = 'v2';
      entry.updatedAt = new Date().toISOString();
      await store.save(entry);

      const stored = await store.get(entry.id);
      expect(stored?.content).toBe('v2');
    });

    it('creates the directory if it does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('New Dir', 'content');
      await store.save(entry);
      // Should not throw — file exists
      await expect(
        fs.access(path.join(paths.globalPrompts, `${entry.id}.json`)),
      ).resolves.toBeUndefined();
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an empty array when the directory does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('returns all saved entries sorted by updatedAt descending', async () => {
      const store = new DefaultPromptStore(paths);
      // Use explicit timestamps so sorting is deterministic regardless of save timing
      const a = store.createNew('A', 'a');
      a.updatedAt = new Date(1000).toISOString();
      const b = store.createNew('B', 'b');
      b.updatedAt = new Date(2000).toISOString();
      const c = store.createNew('C', 'c');
      c.updatedAt = new Date(3000).toISOString();

      await store.save(a);
      await store.save(b);
      await store.save(c);

      const listed = await store.list();
      expect(listed.map((e) => e.title)).toEqual(['C', 'B', 'A']);
    });

    it('skips non-.json files in the directory', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('With Neighbor', 'c');
      await store.save(entry);

      await fs.writeFile(path.join(paths.globalPrompts, 'README.txt'), 'not a prompt');
      await expect(store.list()).resolves.toHaveLength(1);
    });

    it('skips corrupt JSON files without throwing', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Good', 'c');
      await store.save(entry);

      await fs.writeFile(path.join(paths.globalPrompts, '01XXXXXXXX.json'), '{ broken');
      await expect(store.list()).resolves.toHaveLength(1);
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the entry when the file exists', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('Get Me', 'content');
      await store.save(entry);
      await expect(store.get(entry.id)).resolves.toMatchObject({ title: 'Get Me' });
    });

    it('returns null when the id does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.get('nonexistent')).resolves.toBeNull();
    });
  });

  // ── find ────────────────────────────────────────────────────────────────────

  describe('find', () => {
    beforeEach(async () => {
      const store = new DefaultPromptStore(paths);
      await store.save(store.createNew('Deploy Script', 'run npm build && ship', ['deploy']));
      await store.save(store.createNew('Code Review', 'review PRs for bugs', ['pr']));
      await store.save(store.createNew('Readme Writer', 'write a great README', ['docs']));
    });

    it('matches by title (case-insensitive)', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('deploy')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });

    it('matches by content', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('npm build')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });

    it('matches by tag', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('docs')).resolves.toMatchObject([{ title: 'Readme Writer' }]);
    });

    it('returns all matching entries', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('e')).resolves.toHaveLength(3);
    });

    it('returns empty array when nothing matches', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('zzzzz')).resolves.toEqual([]);
    });

    it('is case-insensitive across all fields', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.find('DEPLOY')).resolves.toMatchObject([{ title: 'Deploy Script' }]);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the file and returns true', async () => {
      const store = new DefaultPromptStore(paths);
      const entry = store.createNew('To Delete', 'bye');
      await store.save(entry);

      await expect(store.delete(entry.id)).resolves.toBe(true);
      await expect(store.get(entry.id)).resolves.toBeNull();
    });

    it('returns false when the file does not exist', async () => {
      const store = new DefaultPromptStore(paths);
      await expect(store.delete('doesnotexist')).resolves.toBe(false);
    });
  });

  // ── v1 → v2 migration ────────────────────────────────────────────────────────

  describe('migratePromptEntry', () => {
    it('upgrades a legacy v1 entry with sensible defaults', () => {
      const v1 = {
        id: 'abc12345',
        title: 'Legacy Prompt',
        content: 'old content',
        tags: ['x'],
        createdAt: new Date(1000).toISOString(),
        updatedAt: new Date(2000).toISOString(),
      };
      const migrated = migratePromptEntry(v1);
      expect(migrated).toMatchObject({
        id: 'abc12345',
        slug: 'legacy-prompt',
        title: 'Legacy Prompt',
        description: '',
        category: 'uncategorized',
        source: 'user',
        favorite: false,
        tags: ['x'],
      });
    });

    it('returns null for non-objects and entries missing id/title', () => {
      expect(migratePromptEntry(null)).toBeNull();
      expect(migratePromptEntry('nope')).toBeNull();
      expect(migratePromptEntry({ title: 'no id' })).toBeNull();
      expect(migratePromptEntry({ id: 'x' })).toBeNull();
    });

    it('preserves already-v2 fields', () => {
      const v2 = {
        id: 'id1',
        slug: 'custom-slug',
        title: 'T',
        description: 'desc',
        content: 'c',
        category: 'coding',
        tags: [],
        source: 'builtin',
        favorite: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      expect(migratePromptEntry(v2)).toMatchObject({
        slug: 'custom-slug',
        category: 'coding',
        source: 'builtin',
        favorite: true,
      });
    });
  });

  describe('list() with a legacy v1 file on disk', () => {
    it('reads and migrates a v1 file without rewriting it', async () => {
      const store = new DefaultPromptStore(paths);
      await fs.mkdir(paths.globalPrompts, { recursive: true });
      const file = path.join(paths.globalPrompts, 'legacy.json');
      const v1Raw = {
        version: 1,
        entry: {
          id: 'legacy',
          title: 'Old One',
          content: 'body',
          tags: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      };
      await fs.writeFile(file, JSON.stringify(v1Raw));

      const listed = await store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        slug: 'old-one',
        category: 'uncategorized',
        source: 'user',
      });

      // Disk is NOT mutated on read — still version 1.
      const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(onDisk.version).toBe(1);
    });
  });
});
