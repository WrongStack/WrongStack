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

  it('treats backslash as a path separator so Windows @-queries match', async () => {
    const slash = await searchFiles(root, 'src/components/Button', 5);
    const backslash = await searchFiles(root, 'src\\components\\Button', 5);
    expect(slash[0]).toContain('Button.tsx');
    expect(backslash).toEqual(slash);
  });
});
