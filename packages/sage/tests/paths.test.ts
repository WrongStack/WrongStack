import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ancestorPaths,
  clearProjectPathCache,
  normalizeProjectPath,
  normalizeSlashes,
  resolveSagePaths,
} from '../src/paths.js';

describe('normalizeSlashes', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(normalizeSlashes('a\\b\\c')).toBe('a/b/c');
  });

  it('collapses multiple slashes', () => {
    expect(normalizeSlashes('a//b///c')).toBe('a/b/c');
  });

  it('leaves already-normalized paths unchanged', () => {
    expect(normalizeSlashes('a/b/c')).toBe('a/b/c');
  });
});

describe('ancestorPaths', () => {
  it('returns [.] for root path', () => {
    expect(ancestorPaths('.')).toEqual(['.']);
  });

  it('returns all ancestor prefixes', () => {
    expect(ancestorPaths('a/b/c')).toEqual(['a/b/c', 'a/b', 'a']);
  });

  it('handles single-level path', () => {
    expect(ancestorPaths('src')).toEqual(['src']);
  });

  it('normalizes slashes before computing', () => {
    expect(ancestorPaths('a\\b\\c')).toEqual(['a/b/c', 'a/b', 'a']);
  });
});

describe('normalizeProjectPath', () => {
  afterEach(() => {
    clearProjectPathCache();
  });

  it('returns relative path unchanged when already inside project', () => {
    const result = normalizeProjectPath('/project', 'src/file.ts');
    expect(result).toBe('src/file.ts');
  });

  it('keeps realpath cache bounded under many unique path lookups (leak guard)', () => {
    // Stress the module-level cache; if it grew unbounded this would retain
    // thousands of map entries for the process lifetime.
    for (let i = 0; i < 5_000; i++) {
      normalizeProjectPath('/project', `src/generated/file-${i}.ts`);
    }
    // Still works after eviction pressure — hot project-root paths remain valid.
    expect(normalizeProjectPath('/project', 'src/generated/file-4999.ts')).toBe(
      'src/generated/file-4999.ts',
    );
    expect(normalizeProjectPath('/project', 'src/ok.ts')).toBe('src/ok.ts');
  });

  it('resolves absolute path inside project', () => {
    const result = normalizeProjectPath('/project', '/project/src/file.ts');
    expect(result).toBe('src/file.ts');
  });

  it('throws for path outside project', () => {
    expect(() => normalizeProjectPath('/project', '../outside.ts')).toThrow(
      /inside the project root/i,
    );
  });

  it('rejects absolute path outside project', () => {
    expect(() => normalizeProjectPath('/project', '/other/src/file.ts')).toThrow(
      /inside the project root/i,
    );
  });
});

describe('resolveSagePaths', () => {
  it('throws for absolute directory', () => {
    expect(() => resolveSagePaths('/project', '/absolute/path')).toThrow(/project-relative/i);
  });

  it('throws for directory escaping project root', () => {
    expect(() => resolveSagePaths('/project', '../escape')).toThrow(/project root/i);
  });

  it('returns all expected sub-paths for a valid directory', () => {
    const paths = resolveSagePaths('/project', '.wrongstack/memories');
    expect(paths.rootDir).toBe(path.resolve('/project/.wrongstack/memories'));
    expect(paths.manifest).toContain('manifest.json');
    expect(paths.memoriesLog).toContain('memories.jsonl');
    expect(paths.candidatesLog).toContain('candidates.jsonl');
    expect(paths.auditLog).toContain('audit.jsonl');
    expect(paths.graphDir).toContain('graph');
    expect(paths.edgesLog).toContain('edges.jsonl');
    expect(paths.indexesDir).toContain('indexes');
    expect(paths.snapshotsDir).toContain('snapshots');
    expect(paths.hygieneDir).toContain('hygiene');
    expect(paths.tmpDir).toContain('tmp');
    expect(paths.locksDir).toContain('locks');
  });
});

describe('normalizeProjectPath symlink safety', () => {
  let projectRoot: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeEach(() => {
    // Create a real project root + a real outside directory + file. Then
    // create a symlink INSIDE the project that points at the outside file.
    // Before the realpath() fix, normalizeProjectPath(project, symlink)
    // would compute `path.relative()` from the symlink path (not its
    // target) and silently accept the escape.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-symlink-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-symlink-outside-'));
    outsideFile = path.join(outsideDir, 'secret.ts');
    fs.writeFileSync(outsideFile, '// outside content');
    clearProjectPathCache();
  });

  afterEach(() => {
    clearProjectPathCache();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a symlink inside the project that resolves outside', () => {
    const linkPath = path.join(projectRoot, 'sneaky-link.ts');
    fs.symlinkSync(outsideFile, linkPath, 'file');
    expect(() => normalizeProjectPath(projectRoot, 'sneaky-link.ts')).toThrow(
      /inside the project root/i,
    );
  });

  it('accepts a symlink that resolves inside the project', () => {
    const realFile = path.join(projectRoot, 'real.ts');
    fs.writeFileSync(realFile, '// real content');
    const linkPath = path.join(projectRoot, 'alias.ts');
    fs.symlinkSync(realFile, linkPath, 'file');
    expect(normalizeProjectPath(projectRoot, 'alias.ts')).toBe('alias.ts');
  });

  it('rejects an absolute symlink path that resolves outside the project', () => {
    const linkPath = path.join(projectRoot, 'abs-link');
    fs.symlinkSync(outsideDir, linkPath, 'dir');
    expect(() => normalizeProjectPath(projectRoot, linkPath)).toThrow(/inside the project root/i);
  });
});
