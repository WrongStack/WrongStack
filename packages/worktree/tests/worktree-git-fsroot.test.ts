import { parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafePath } from '../src/worktree-git.js';

describe('assertSafePath filesystem root containment (F297)', () => {
  it('accepts child paths when projectRoot is a filesystem root', () => {
    const fsRoot = parse(process.cwd()).root;
    expect(() => assertSafePath(`${fsRoot}repo`, fsRoot)).not.toThrow();
  });

  it('still rejects paths outside a non-root projectRoot', () => {
    expect(() => assertSafePath('/other/place', '/base/project')).toThrow(
      /worktree path escapes project root/,
    );
  });
});
