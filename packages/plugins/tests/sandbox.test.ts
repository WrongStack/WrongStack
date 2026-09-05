/**
 * Tests for runtime/sandbox.ts — safePath, isInsideProject.
 *
 * Pins SAGE memory T-03 sandbox layer:
 *  - the canonical within-project check
 *  - symlink target outside project is rejected
 *  - empty / oversized / leading-dash inputs are rejected
 *  - relative paths resolve against projectRoot
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInsideProject, safePath } from '../src/runtime/sandbox.js';

let projectRoot: string;
let tempRoot: string;

beforeAll(async () => {
  // Set up an isolated sandbox: a real temp dir + a sibling "outside" dir.
  tempRoot = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
  projectRoot = join(tempRoot, 'project');
  const outsideDir = join(tempRoot, 'outside');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(join(projectRoot, 'inside.txt'), 'inside');
  await writeFile(join(outsideDir, 'outside.txt'), 'outside');

  // Symlink inside the project that points OUTSIDE — must be rejected.
  await symlink(join(outsideDir, 'outside.txt'), join(projectRoot, 'link-to-outside.txt'));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('safePath', () => {
  it('returns the canonical absolute path for an absolute path inside the project', () => {
    const abs = join(projectRoot, 'inside.txt');
    expect(safePath(abs, { projectRoot })).toBe(abs);
  });

  it('resolves a relative path against projectRoot', () => {
    const resolved = resolve(projectRoot, 'inside.txt');
    expect(safePath('inside.txt', { projectRoot })).toBe(resolved);
  });

  it('rejects a symlink that points outside the project', () => {
    const linkInsideProject = join(projectRoot, 'link-to-outside.txt');
    expect(safePath(linkInsideProject, { projectRoot })).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(safePath('', { projectRoot })).toBeNull();
  });

  it('rejects an oversized input (> 4096 bytes)', () => {
    expect(safePath('a'.repeat(4097), { projectRoot })).toBeNull();
  });

  it('rejects a leading-dash input (option smuggling)', () => {
    expect(safePath('-rf', { projectRoot })).toBeNull();
    expect(safePath('--help', { projectRoot })).toBeNull();
  });

  it('rejects a path that escapes via parent traversal', () => {
    const escapePath = join(projectRoot, '..', 'outside', 'outside.txt');
    expect(safePath(escapePath, { projectRoot })).toBeNull();
  });

  it('accepts a new in-project file by default while canonicalizing existing ancestors', () => {
    const ghost = join(projectRoot, 'new-file.txt');
    expect(safePath(ghost, { projectRoot })).toBe(ghost);
  });

  it('returns the lexical path when followSymlinks is false and the target does not exist', () => {
    const ghost = join(projectRoot, 'does-not-exist-yet.txt');
    expect(safePath(ghost, { projectRoot, followSymlinks: false })).toBe(ghost);
    expect(safePath(ghost, { projectRoot, followSymlinks: true })).toBe(ghost);
  });

  it('rejects a non-string input', () => {
    expect(safePath(undefined as unknown as string, { projectRoot })).toBeNull();
    expect(safePath(null as unknown as string, { projectRoot })).toBeNull();
    expect(safePath(123 as unknown as string, { projectRoot })).toBeNull();
    expect(safePath({} as unknown as string, { projectRoot })).toBeNull();
  });
});

describe('isInsideProject', () => {
  it('returns true for an absolute path inside the project', () => {
    expect(isInsideProject(join(projectRoot, 'inside.txt'), { projectRoot })).toBe(true);
  });

  it('returns false for a symlink that escapes the project', () => {
    expect(isInsideProject(join(projectRoot, 'link-to-outside.txt'), { projectRoot })).toBe(false);
  });

  it('returns false for an empty input', () => {
    expect(isInsideProject('', { projectRoot })).toBe(false);
  });
});
