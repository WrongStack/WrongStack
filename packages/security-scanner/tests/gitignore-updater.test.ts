import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GitignoreUpdater, defaultGitignoreUpdater } from '../src/gitignore-updater.js';

let tmp: string;
let gitignorePath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-upd-'));
  gitignorePath = path.join(tmp, '.gitignore');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitignoreUpdater', () => {
  it('exports a default singleton', () => {
    expect(defaultGitignoreUpdater).toBeInstanceOf(GitignoreUpdater);
  });

  it('creates a new .gitignore when one does not exist and lists every entry as added', async () => {
    const u = new GitignoreUpdater({
      gitignorePath,
      entries: ['security-reports/', 'security-reports/*'],
    });
    const result = await u.update();
    expect(result.added).toEqual(['security-reports/', 'security-reports/*']);
    expect(result.existing).toEqual([]);
    expect(result.errors).toEqual([]);
    const content = await fs.readFile(gitignorePath, 'utf8');
    expect(content).toContain('security-reports/');
    expect(content).toContain('security-reports/*');
  });

  it('appends missing entries to an existing .gitignore without duplicating', async () => {
    await fs.writeFile(gitignorePath, 'node_modules\n.env\n');
    const u = new GitignoreUpdater({
      gitignorePath,
      entries: ['node_modules', 'security-reports/'],
    });
    const result = await u.update();
    expect(result.added).toEqual(['security-reports/']);
    expect(result.existing).toEqual(['node_modules']);
    const content = await fs.readFile(gitignorePath, 'utf8');
    // Should appear exactly once
    expect(content.match(/node_modules/g)?.length).toBe(1);
    expect(content).toContain('security-reports/');
  });

  it('does not rewrite the file when every entry is already present', async () => {
    await fs.writeFile(gitignorePath, 'foo\nbar\n');
    const u = new GitignoreUpdater({
      gitignorePath,
      entries: ['foo', 'bar'],
    });
    // Capture mtime before
    const before = (await fs.stat(gitignorePath)).mtimeMs;
    // Wait one tick so a write would change mtime
    await new Promise((r) => setTimeout(r, 10));
    const result = await u.update();
    expect(result.added).toEqual([]);
    expect(result.existing).toEqual(['foo', 'bar']);
    // File untouched
    const after = (await fs.stat(gitignorePath)).mtimeMs;
    expect(after).toBe(before);
  });

  it('records an error when reading .gitignore fails for non-ENOENT reasons', async () => {
    // Point to a directory path (not a file) — readFile fails with EISDIR / EACCES
    const u = new GitignoreUpdater({ gitignorePath: tmp, entries: ['x'] });
    const result = await u.update();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Failed to update .gitignore/);
  });

  it('isEntryIgnored returns true when the entry is present', async () => {
    await fs.writeFile(gitignorePath, 'a\nb\nsecurity-reports/\n');
    const u = new GitignoreUpdater({ gitignorePath, entries: [] });
    expect(await u.isEntryIgnored('security-reports/')).toBe(true);
    expect(await u.isEntryIgnored('not-in-list')).toBe(false);
  });

  it('isEntryIgnored returns false when .gitignore does not exist', async () => {
    const u = new GitignoreUpdater({ gitignorePath, entries: [] });
    expect(await u.isEntryIgnored('anything')).toBe(false);
  });

  it('uses default entries when none are passed to the constructor', async () => {
    const u = new GitignoreUpdater({ gitignorePath });
    const result = await u.update();
    expect(result.added).toContain('security-reports/');
    expect(result.added).toContain('security-reports/*');
  });
});
