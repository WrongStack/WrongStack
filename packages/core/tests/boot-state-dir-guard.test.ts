import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { assertProjectRootOutsideStateDir } from '../src/boot.js';

/**
 * Regression guard for the nested-project bug.
 *
 * A WrongStack process spawned with a state path as its cwd resolved that
 * state directory as its own project root (no marker above it, and the
 * home-directory walk-stop guarantees the cwd fallback). Boot then registered
 * a second, nested project `<slug>-<hash>` carrying its own meta.json,
 * projects.json entry, mailbox lock and token — splitting coordination state
 * across two namespaces, with the nested one always winning `lastSeen`.
 *
 * The original trigger was fixed at the call site
 * (packages/cli/src/mailbox-bridge-bootstrap.ts spawns with cwd=projectRoot).
 * This is the backstop so the next caller that makes the same mistake fails
 * loudly instead of silently forking the namespace.
 */
describe('assertProjectRootOutsideStateDir', () => {
  const globalRoot = path.resolve('/home/testuser/.wrongstack');

  it('allows a normal project root outside the state dir', () => {
    expect(() =>
      assertProjectRootOutsideStateDir(path.resolve('/repos/my-app'), globalRoot),
    ).not.toThrow();
  });

  it('allows a sibling directory whose name merely prefixes the state dir', () => {
    // Naive `startsWith` string matching would reject this; path.relative
    // does not.
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.resolve('/home/testuser/.wrongstack-notes'),
        globalRoot,
      ),
    ).not.toThrow();
  });

  it('rejects the per-project state dir (the observed bug)', () => {
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.resolve('/home/testuser/.wrongstack/projects/wrongstack-6fc446'),
        globalRoot,
      ),
    ).toThrow(/per-project state directory/);
  });

  it('rejects the projects namespace root itself', () => {
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.resolve('/home/testuser/.wrongstack/projects'),
        globalRoot,
      ),
    ).toThrow(/per-project state directory/);
  });

  it('allows a real repo nested under a custom WRONGSTACK_HOME', () => {
    // The bridge tests point WRONGSTACK_HOME at a tmpdir and create the
    // project inside it. That is not the bug — only `projects/` is.
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.resolve('/home/testuser/.wrongstack/project-abc123'),
        globalRoot,
      ),
    ).not.toThrow();
  });

  it('names both offending paths so the failure is actionable', () => {
    const bad = path.resolve('/home/testuser/.wrongstack/projects/some-slug');
    expect(() => assertProjectRootOutsideStateDir(bad, globalRoot)).toThrow(
      new RegExp(bad.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
    );
  });
});
