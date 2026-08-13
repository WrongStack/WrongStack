import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every tool that turns a caller-supplied path into a filesystem operation
 * must resolve it through the REALPATH form.
 *
 * `safeResolve` is the syntactic `../` check only. `safeResolveReal` (and the
 * `resolveRealInsideRoot` it wraps) additionally follows symlinks and junctions
 * and re-checks containment, returning the canonical path — the value the
 * caller then opens.
 *
 * The upgrade was rolled out file-by-file instead of as an enforced boundary,
 * and two tools were missed for months: `grep` (read exfiltration — a junction
 * as the search base enumerated files outside the root) and `patch` (arbitrary
 * out-of-root WRITES, because GNU patch resolves the junction in the OS after
 * the syntactic preflight passed). `glob.test.ts` even carries a regression
 * test named "rejects a base path that itself resolves outside the project
 * root" — the exact case `grep` was missing.
 *
 * This test is the mechanical version of that review: it fails when a tool
 * reaches for the syntactic helper alone, so the next one cannot be missed.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Tools whose caller-supplied paths must go through the realpath form. */
const REALPATH_REQUIRED = [
  'read.ts',
  'write.ts',
  'edit.ts',
  'glob.ts',
  'grep.ts',
  'patch.ts',
  // The `files`-only dump path OPENS the resolved file, so it needs the
  // realpath form like the other content-opening tools.
  'diff.ts',
  // Opens every file it documents.
  'document.ts',
  // Rewrites every file it resolves — a mutating tool must never follow an
  // in-root link out of the root.
  'replace.ts',
  // Walks and lists a tree; a junction as the base enumerated names outside
  // the root (the `grep` case, one tool over).
  'tree.ts',
  // WRITES generated files under the resolved destination.
  'scaffold.ts',
  // The remainder spawn a process with the resolved path as its cwd, which
  // hands the escape to the child instead of performing it directly. Same
  // boundary, one process removed.
  'audit.ts',
  'format.ts',
  'install.ts',
  'lint.ts',
  'logs.ts',
  'outdated.ts',
  'test.ts',
  'typecheck.ts',
] as const;

/**
 * Files that legitimately use `safeResolve` alone, each with a stated reason.
 * Adding an entry here is a deliberate decision, not an oversight.
 */
const SYNTACTIC_ONLY_ALLOWED: Record<string, string> = {
  // Empty on purpose. Both former entries were removed once their stated
  // reasons were checked rather than assumed:
  //
  //   - `tree.ts` claimed "listing only — does not open the resolved path".
  //     Listing IS the disclosure: a junction as the base enumerated names
  //     outside the root, which is the same bug `grep` was carrying.
  //   - `scaffold.ts` claimed it "does its own check". It did not — the check
  //     was `path.resolve` alone, so a junction at `cwd` wrote template files
  //     straight through it. The comment asserting containment was the only
  //     containment present.
  //
  // Both now use the realpath form. An entry here must survive the same
  // question: not "does the code say it is safe", but "what happens when the
  // path is a junction".
};

function read(file: string): string {
  return readFileSync(path.join(SRC, file), 'utf8');
}

describe('file tools resolve caller paths through the realpath guard', () => {
  it.each(REALPATH_REQUIRED)('%s imports safeResolveReal or resolveRealInsideRoot', (file) => {
    const source = read(file);
    const usesReal = /\b(safeResolveReal|resolveRealInsideRoot)\b/.test(source);
    expect(
      usesReal,
      `${file} resolves a caller-supplied path but never calls the realpath guard. ` +
        `A junction or symlink inside the project satisfies the syntactic check and ` +
        `still resolves outside it.`,
    ).toBe(true);
  });

  it.each(REALPATH_REQUIRED)('%s does not fall back to the syntactic helper alone', (file) => {
    const source = read(file);
    if (!/\bsafeResolve\b/.test(source)) return; // uses only the real form
    // When both appear, the syntactic one must not be the only guard on a
    // caller-supplied entry point. `patch` used exactly this shape.
    const usesReal = /\b(safeResolveReal|resolveRealInsideRoot)\b/.test(source);
    expect(usesReal, `${file} calls safeResolve without any realpath check`).toBe(true);
  });

  it('the allow-list only names files that really are syntactic-only', () => {
    for (const [file, reason] of Object.entries(SYNTACTIC_ONLY_ALLOWED)) {
      const source = read(file);
      expect(reason.length, `${file} needs a stated reason`).toBeGreaterThan(10);
      expect(
        /\bsafeResolve\b/.test(source),
        `${file} no longer uses safeResolve — drop it from SYNTACTIC_ONLY_ALLOWED`,
      ).toBe(true);
    }
  });
});
