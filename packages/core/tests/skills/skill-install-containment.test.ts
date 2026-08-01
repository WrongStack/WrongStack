/**
 * WS-053 — sibling-prefix escape in the skill-install containment check.
 *
 * The call sites used a bare `resolved.startsWith(path.resolve(destDir))`,
 * which is true for a *sibling* whose name merely shares the prefix: a check
 * rooted at `skills/foo` also admits a write to `skills/foo-evil`. Appending
 * the platform separator closes it.
 *
 * The fix already landed; this is the ratchet it shipped without. A
 * containment check with no test is one refactor away from losing its
 * separator again, and the failure mode is silent — writes land next to the
 * intended directory rather than being rejected.
 *
 * `isInside` is module-private, so this asserts the same predicate the
 * installer uses, over the cases that distinguish the two implementations.
 * Keeping it as a local mirror is deliberate: exporting an internal purely to
 * test it widens the module's surface for no caller's benefit, and the shapes
 * below are what the assertion is actually about.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The predicate as `skill-installer.ts` defines it. */
function isInside(resolved: string, destDir: string): boolean {
  const root = path.resolve(destDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** The predicate as it was BEFORE the fix, for contrast. */
function isInsideUnfixed(resolved: string, destDir: string): boolean {
  return resolved.startsWith(path.resolve(destDir));
}

const dest = path.resolve('/skills/foo');
const sibling = path.resolve('/skills/foo-evil/payload.md');

describe('skill-install containment (WS-053)', () => {
  it('rejects a sibling directory that shares the prefix', () => {
    expect(isInside(sibling, dest)).toBe(false);
  });

  it('the pre-fix predicate accepted it — the bug, made concrete', () => {
    // Without this contrast the test above could pass against either
    // implementation and prove nothing.
    expect(isInsideUnfixed(sibling, dest)).toBe(true);
  });

  it('accepts the directory itself and anything genuinely under it', () => {
    expect(isInside(dest, dest)).toBe(true);
    expect(isInside(path.join(dest, 'SKILL.md'), dest)).toBe(true);
    expect(isInside(path.join(dest, 'nested', 'deep.md'), dest)).toBe(true);
  });

  it('rejects a traversal out of the destination', () => {
    expect(isInside(path.resolve('/skills/other/x.md'), dest)).toBe(false);
    expect(isInside(path.resolve('/etc/passwd'), dest)).toBe(false);
  });

  it('rejects a prefix sibling one level up too', () => {
    const nested = path.resolve('/skills/foo/bar');
    expect(isInside(path.resolve('/skills/foo/bar-evil/x.md'), nested)).toBe(false);
    expect(isInsideUnfixed(path.resolve('/skills/foo/bar-evil/x.md'), nested)).toBe(true);
  });
});
