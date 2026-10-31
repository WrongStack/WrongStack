import * as path from 'node:path';
import { isInsideDirectory } from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

// `isInsideDirectory` used a bare `relative.startsWith('..')`, which misreads a
// legal in-root first segment that begins with '..' as an escape. Canonical
// predicate: rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel).
describe('isInsideDirectory', () => {
  const root = path.resolve('/project/root');

  it('accepts a legal in-root ..-prefixed first segment', () => {
    expect(isInsideDirectory(root, path.join(root, '..hidden', 'state.json'))).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isInsideDirectory(root, root)).toBe(true);
  });

  it('accepts ordinary nested paths', () => {
    expect(isInsideDirectory(root, path.join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('rejects real parent traversal', () => {
    expect(isInsideDirectory(root, path.resolve(root, '..', 'outside.txt'))).toBe(false);
  });
});
