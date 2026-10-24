/**
 * Regression tests for the pre-commit Core API snapshot guard's decision
 * semantics (scripts/sync-core-public-api-snapshot.mjs).
 *
 * Locked-in contract, motivated by the 2026-09-20 shared-worktree incident:
 * a fenced commit whose staged set contains NO snapshot input must pass
 * (skip regeneration) even while unrelated peer edits to snapshot inputs sit
 * unstaged/untracked in the tree — those edits cannot reach the generated
 * artifacts because regeneration never runs. Conversely, when the staged set
 * DOES touch snapshot inputs, regeneration would read the dirty working tree,
 * so any other unstaged/untracked input must still hard-fail the sync (the
 * fail-closed safety that prevents capturing unrelated shared-worktree work
 * into the committed architecture artifacts).
 *
 * INPUT SCOPE: a file feeds the artifacts only if it is part of `packages/core`
 * (whose `src/**` the inventory walks unconditionally, plus its manifest and
 * the policy file), or if its CONTENT imports `@wrongstack/core` — the usage
 * census only records specifiers that resolve into the package. The previous
 * path-shape-only predicate classified every `.ts`/`.tsx`/`.js` under
 * `packages|apps|scripts` as an input, which made the `skip` branch unreachable
 * for every non-Core commit and let unrelated peers block it.
 *
 * The decision is exercised through the exported pure functions with an
 * INJECTED reader, so no test touches the real filesystem or the index. The
 * reader is injected deliberately: with the default disk reader an unreadable
 * path fails CLOSED to `true`, which would make a "not an input" assertion pass
 * for the wrong reason.
 */
import { describe, expect, it } from 'vitest';

const SCRIPT_URL = new URL(
  '../../../../scripts/sync-core-public-api-snapshot.mjs',
  import.meta.url,
);

type ReadSource = (file: string) => string;

interface SnapshotDecision {
  action: 'skip' | 'generate' | 'fail';
  stagedInputs: string[];
  unsafeInputs?: string[];
}

interface SnapshotScript {
  isSnapshotInput(file: string, readSource?: ReadSource): boolean;
  changedSnapshotInputs(files: readonly string[], readSource?: ReadSource): string[];
  decideSnapshotAction(input: {
    staged?: string[];
    unstaged?: string[];
    untracked?: string[];
    readSource?: ReadSource;
  }): SnapshotDecision;
}

// Runtime-computed specifier keeps TypeScript from trying to resolve the
// untyped root .mjs; the shape is asserted locally.
const script = (await import(SCRIPT_URL.href)) as unknown as SnapshotScript;
const { isSnapshotInput, changedSnapshotInputs, decideSnapshotAction } = script;

/** In-memory fixture contents, keyed by repo-relative path. */
// Build fixture specifiers at runtime so the import census cannot count them
// as dependencies of this test file itself.
const corePackage = '@wrongstack/core';
const SOURCES: Record<string, string> = {
  'packages/tools/src/fetch.ts': `import type { Foo } from '${corePackage}/types';\n`,
  'packages/tools/tests/fetch.test.ts': "import { tool } from '@wrongstack/tools';\n",
  'scripts/sync-core-public-api-snapshot.mjs': "import path from 'node:path';\n",
  'apps/desktop/src/main.ts': `import { boot } from '${corePackage}/kernel';\n`,
  'packages/cli/src/foo.jsx': "import React from 'react';\n",
  'packages/core/src/index.ts': "export * from './typesafe/index.js';\n",
  'packages/core/src/coordination/director.ts': 'export const director = 1;\n',
  'packages/core/src/legacy.ts': 'export const legacy = 1;\n',
  // The generator itself scans the tree, so it imports nothing from core —
  // yet it is the thing that PRODUCES the artifacts.
  'scripts/snapshot-core-public-api.mjs': "import { readdirSync } from 'node:fs';\n",
  'scripts/build-package.mjs': "import { glob } from 'node:fs';\n",
  'packages/runtime/src/jev-checks.ts': `import { check } from '${corePackage}/kernel';\n`,
  'packages/cli/src/cli-main.ts': "import { run } from '@wrongstack/runtime';\n",
  'packages/tui/src/app-view.tsx': "import { Panel } from '@wrongstack/tui/components';\n",
  'packages/tui/src/components/history/banner.tsx': 'export function Banner() { return null; }\n',
  'packages/techstack/src/adapters/npm.ts': "import { readFile } from 'node:fs/promises';\n",
  'packages/tui/tests/banner-formation.test.tsx': "import { formatBanner } from '../banner';\n",
};

/** Reader over {@link SOURCES}; unknown paths are unreadable (fail closed). */
const readFixture: ReadSource = (file) => {
  const content = SOURCES[file];
  if (content === undefined) throw new Error(`ENOENT: ${file}`);
  return content;
};

/** Reader that always throws, to exercise the fail-closed path. */
const readUnreadable: ReadSource = () => {
  throw new Error('EACCES');
};

describe('sync-core-public-api-snapshot input classification', () => {
  it('treats every file under packages/core/src as an input regardless of imports', () => {
    // None of these import @wrongstack/core, yet the inventory walks core/src
    // unconditionally, so every one of them moves the snapshot.
    expect(isSnapshotInput('packages/core/src/index.ts', readFixture)).toBe(true);
    expect(isSnapshotInput('packages/core/src/coordination/director.ts', readFixture)).toBe(true);
    expect(isSnapshotInput('packages/core/src/typesafe/readiness.ts', readFixture)).toBe(true);
  });

  it('treats the policy/package manifests as inputs regardless of extension', () => {
    expect(isSnapshotInput('packages/core/package.json')).toBe(true);
    expect(isSnapshotInput('architecture/core-api-policy.json')).toBe(true);
  });

  it('treats a non-core source as an input only when it imports @wrongstack/core', () => {
    expect(isSnapshotInput('packages/tools/src/fetch.ts', readFixture)).toBe(true);
    expect(isSnapshotInput('apps/desktop/src/main.ts', readFixture)).toBe(true);
    expect(isSnapshotInput('packages/runtime/src/jev-checks.ts', readFixture)).toBe(true);

    expect(isSnapshotInput('packages/tools/tests/fetch.test.ts', readFixture)).toBe(false);
    expect(isSnapshotInput('packages/cli/src/cli-main.ts', readFixture)).toBe(false);
    expect(isSnapshotInput('packages/cli/src/foo.jsx', readFixture)).toBe(false);
  });

  it('does NOT classify unrelated UI work as an input (the blocked case)', () => {
    // These are the paths that blocked a packages/techstack commit: none import
    // @wrongstack/core, so none can change the generated artifacts.
    expect(isSnapshotInput('packages/tui/src/app-view.tsx', readFixture)).toBe(false);
    expect(isSnapshotInput('packages/tui/src/components/history/banner.tsx', readFixture)).toBe(
      false,
    );
    expect(isSnapshotInput('packages/tui/tests/banner-formation.test.tsx', readFixture)).toBe(
      false,
    );
  });

  it('matches the bare root specifier as well as a subpath', () => {
    expect(isSnapshotInput('packages/x/a.ts', () => `import '${corePackage}';`)).toBe(true);
    expect(isSnapshotInput('packages/x/b.ts', () => `from '${corePackage}/kernel';`)).toBe(true);
    // A package whose name merely starts the same way is not a match.
    expect(isSnapshotInput('packages/x/c.ts', () => `import '${corePackage}utils';`)).toBe(false);
  });

  it('fails closed when a source file cannot be read', () => {
    // A false negative would let a peer's in-flight edit reach the committed
    // artifacts — the one failure this guard exists to prevent.
    expect(isSnapshotInput('packages/tools/src/fetch.ts', readUnreadable)).toBe(true);
    expect(isSnapshotInput('packages/ghost/src/gone.ts', readUnreadable)).toBe(true);
  });

  it('does not treat non-source files as inputs', () => {
    expect(isSnapshotInput('docs/notes.md', readFixture)).toBe(false);
    expect(isSnapshotInput('package-lock.json', readFixture)).toBe(false);
    expect(isSnapshotInput('README.md', readFixture)).toBe(false);
    expect(isSnapshotInput('packages/core/src/parser.py', readFixture)).toBe(false);
    expect(isSnapshotInput('logo.svg', readFixture)).toBe(false);
    expect(isSnapshotInput('website/src/main.tsx', readFixture)).toBe(false);
    expect(isSnapshotInput('architecture/core-public-api-snapshot.json', readFixture)).toBe(false);
  });

  it('filters, deduplicates, and sorts changed inputs', () => {
    expect(
      changedSnapshotInputs(
        [
          'packages/runtime/src/jev-checks.ts',
          'docs/skip.md',
          'packages/cli/src/cli-main.ts',
          'packages/core/src/index.ts',
          'packages/runtime/src/jev-checks.ts',
        ],
        readFixture,
      ),
    ).toEqual(['packages/core/src/index.ts', 'packages/runtime/src/jev-checks.ts']);
  });
});

describe('sync-core-public-api-snapshot decision semantics', () => {
  it('skips (passes) when the staged set touches no input, despite dirty inputs elsewhere', () => {
    // The 2026-09-20 incident: fenced non-input commit blocked by peer edits.
    const decision = decideSnapshotAction({
      staged: ['docs/release-notes.md', 'logo.svg'],
      unstaged: ['packages/core/src/typesafe/settings.ts'],
      untracked: ['packages/core/src/typesafe/readiness.ts'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('skip');
    expect(decision.stagedInputs).toEqual([]);
  });

  it('skips a fenced non-core commit while unrelated peers have TS files dirty', () => {
    // The regression this narrowing fixes: staging packages/techstack work
    // (which imports nothing from core) must not be blocked by peers editing
    // packages/tui.
    const decision = decideSnapshotAction({
      staged: ['packages/techstack/src/adapters/npm.ts'],
      unstaged: ['packages/tui/src/app-view.tsx'],
      untracked: ['packages/tui/src/components/history/banner.tsx'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('skip');
    expect(decision.stagedInputs).toEqual([]);
  });

  it('skips when nothing is staged at all', () => {
    const decision = decideSnapshotAction({
      staged: [],
      unstaged: ['packages/tui/src/app.ts'],
      untracked: ['packages/tools/src/new.ts'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('skip');
  });

  it('generates when staged inputs exist and the rest of the tree is clean', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/tools/src/fetch.ts'],
      unstaged: [],
      untracked: [],
      readSource: readFixture,
    });
    expect(decision.action).toBe('generate');
    expect(decision.stagedInputs).toEqual(['packages/tools/src/fetch.ts']);
  });

  it('still fails closed when staged inputs exist alongside unstaged peer inputs', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/tools/src/fetch.ts'],
      unstaged: ['packages/core/src/typesafe/client.ts'],
      untracked: ['packages/core/src/typesafe/readiness.ts'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('fail');
    expect(decision.unsafeInputs).toEqual([
      'packages/core/src/typesafe/client.ts',
      'packages/core/src/typesafe/readiness.ts',
    ]);
  });

  it('still fails closed when a peer edit to a core-importing file is dirty', () => {
    // Content-gating must not weaken the guard: an unstaged edit to a file
    // that DOES import core can change the regenerated census.
    const decision = decideSnapshotAction({
      staged: ['packages/core/src/index.ts'],
      unstaged: ['packages/runtime/src/jev-checks.ts'],
      untracked: [],
      readSource: readFixture,
    });
    expect(decision.action).toBe('fail');
    expect(decision.unsafeInputs).toEqual(['packages/runtime/src/jev-checks.ts']);
  });

  it('ignores dirty non-input files when deciding to fail', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/tools/src/fetch.ts'],
      unstaged: ['packages/tui/src/app-view.tsx'],
      untracked: ['packages/tui/tests/banner-formation.test.tsx'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('generate');
  });

  it('fails closed for untracked core-importing inputs alone when regeneration would run', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/core/src/index.ts'],
      unstaged: [],
      untracked: ['packages/runtime/src/jev-checks.ts'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('fail');
    expect(decision.unsafeInputs).toEqual(['packages/runtime/src/jev-checks.ts']);
  });

  it('does not let non-input dirt block a staged-input commit', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/core/src/index.ts'],
      unstaged: ['docs/notes.md'],
      untracked: ['assets/new-logo.svg'],
      readSource: readFixture,
    });
    expect(decision.action).toBe('generate');
  });

  it('fails closed when the staged set mixes inputs and non-inputs with peer dirt', () => {
    const decision = decideSnapshotAction({
      staged: ['packages/tools/src/fetch.ts', 'docs/notes.md'],
      unstaged: ['packages/runtime/src/jev-checks.ts'],
      untracked: [],
      readSource: readFixture,
    });
    expect(decision.action).toBe('fail');
    expect(decision.stagedInputs).toEqual(['packages/tools/src/fetch.ts']);
    expect(decision.unsafeInputs).toEqual(['packages/runtime/src/jev-checks.ts']);
  });
});
