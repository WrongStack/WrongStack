import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/check-architecture-health.mjs` must measure the REPOSITORY, not
 * whatever directory the command happened to be invoked from.
 *
 * It resolved `repoRoot` from `process.cwd()`. `.githooks/pre-commit` always
 * runs it from the repo root, so the hook looked correct — and the bug only
 * surfaced through evidence that had already gone wrong: a committed
 * `architecture/test-only-exports.json` entry pointing at
 * `packages/tui/src/components/history/banner-formation.ts`, an UNTRACKED
 * teammate file. The regenerated report pair had absorbed working-tree state
 * that was never committed.
 *
 * The regression is asserted from a SUBDIRECTORY, because that is the only
 * invocation shape where the two root-resolution strategies disagree. Run from
 * the repo root both produce identical output, so a root-level test would pass
 * against the broken code and prove nothing.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const scriptPath = path.join(repoRoot, 'scripts/check-architecture-health.mjs');

/**
 * Run the script with `cwd` set to `cwd`, bypassing shell quoting entirely.
 * The default (no-argument) mode writes no files — only `--write` and
 * `--write-hotspot-baseline` do — so this is safe to spawn from a test.
 */
function runFrom(cwd: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '' };
  }
}

describe('architecture health resolves the repository root from its own location', () => {
  it('measures the whole repository when invoked from a subdirectory', () => {
    const { stdout } = runFrom(path.join(repoRoot, 'packages/techstack'));

    // A cwd-scoped run would see only `packages/techstack` and find no sibling
    // workspaces. Assert on packages that live far from the cwd, so the
    // assertion fails for the wrong-root implementation rather than for a
    // missing file or a formatting change.
    expect(stdout).toContain('@wrongstack/webui');
    expect(stdout).toContain('@wrongstack/core');
    expect(stdout).toContain('@wrongstack/techstack');

    // `packages/tools` is not under `packages/techstack` at all — a relative
    // reference that can only resolve when repoRoot is the repository root.
    // Match the directory, not one file: which files make the largest-files
    // table shifts every time a hotspot is split.
    expect(stdout).toContain('packages/tools/src/');
  }, 300_000);

  it('finds the same workspace inventory from a nested subdirectory as from the root', () => {
    const fromRoot = runFrom(repoRoot);
    const fromNested = runFrom(path.join(repoRoot, 'packages/tools/src'));

    const packageRows = (output: string): string[] =>
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('| @wrongstack/'));

    expect(fromNested.status).toBe(fromRoot.status);
    expect(packageRows(fromNested.stdout).sort()).toEqual(packageRows(fromRoot.stdout).sort());
  }, 600_000);
});
