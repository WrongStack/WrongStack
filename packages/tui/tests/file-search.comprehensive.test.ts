import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateFileCache, searchFiles } from '../src/file-search.js';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tui-search-'));
  await fs.mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'utils'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'evil'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# x');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), '');
  await fs.writeFile(path.join(root, 'src', 'app.tsx'), '');
  await fs.writeFile(path.join(root, 'src', 'components', 'Button.tsx'), '');
  await fs.writeFile(path.join(root, 'src', 'components', 'Input.tsx'), '');
  await fs.writeFile(path.join(root, 'src', 'utils', 'helpers.ts'), '');
  await fs.writeFile(path.join(root, 'node_modules', 'evil', 'pkg.js'), '');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), '');
  // Add a .env.example file (should NOT be ignored like other dotfiles)
  await fs.writeFile(path.join(root, '.env.example'), 'KEY=value');
  invalidateFileCache();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  invalidateFileCache();
});

describe('searchFiles', () => {
  it('returns top files when query is empty', async () => {
    const matches = await searchFiles(root, '', 10);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches).toContain('README.md');
    expect(matches).toContain('src/index.ts');
  });

  it('skips node_modules and .git', async () => {
    const matches = await searchFiles(root, '', 100);
    expect(matches.some((m) => m.includes('node_modules'))).toBe(false);
    expect(matches.some((m) => m.startsWith('.git'))).toBe(false);
  });

  it('includes .env.example despite starting with dot', async () => {
    const matches = await searchFiles(root, '', 100);
    expect(matches).toContain('.env.example');
  });

  it('fuzzy-matches subsequences', async () => {
    const matches = await searchFiles(root, 'btn', 5);
    expect(matches[0]).toContain('Button.tsx');
  });

  it('ranks tighter span over looser span', async () => {
    const matches = await searchFiles(root, 'input', 5);
    expect(matches[0]).toContain('Input.tsx');
  });

  it('limits results', async () => {
    const matches = await searchFiles(root, '', 2);
    expect(matches.length).toBe(2);
  });

  it('returns empty array on impossible query', async () => {
    const matches = await searchFiles(root, 'zzzzzzzzz', 5);
    expect(matches).toEqual([]);
  });

  it('handles non-existent root directory', async () => {
    await expect(searchFiles('/nonexistent/path/xyz', 'test', 5)).resolves.toEqual([]);
  });

  it('cache returns same data on repeated call', async () => {
    invalidateFileCache();
    const first = await searchFiles(root, '', 100);
    const second = await searchFiles(root, '', 100);
    expect(first).toEqual(second);
  });
});

describe('invalidateFileCache', () => {
  it('clears the cache', async () => {
    invalidateFileCache();
    const before = await searchFiles(root, '', 100);
    invalidateFileCache();
    const after = await searchFiles(root, '', 100);
    expect(after).toEqual(before);
  });

  it('a file created after indexing becomes searchable after invalidation, before TTL expiry', async () => {
    invalidateFileCache();
    // Build the index while the file does not exist yet.
    expect(await searchFiles(root, 'latecreated', 10)).toEqual([]);
    const file = path.join(root, 'late-created.ts');
    await fs.writeFile(file, '');
    try {
      // The 30s TTL cache is still fresh: without invalidation the new file
      // stays invisible (this is the mid-session tool-write gap, report I4).
      expect(await searchFiles(root, 'latecreated', 10)).toEqual([]);
      invalidateFileCache();
      expect(await searchFiles(root, 'latecreated', 10)).toContain('late-created.ts');
    } finally {
      await fs.rm(file, { force: true });
      invalidateFileCache();
    }
  });
});

describe('empty query returns cached results', () => {
  it('returns from cache when TTL is not expired', async () => {
    invalidateFileCache();
    const first = await searchFiles(root, '', 5);
    expect(first.length).toBeGreaterThan(0);
    // Second call should hit cache
    const second = await searchFiles(root, '', 5);
    expect(second).toEqual(first);
  });
});
