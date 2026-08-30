/**
 * What the CLI loads before it knows what it was asked to do.
 *
 * `packages/cli/dist/index.js` is evaluated by EVERY `wstack` invocation —
 * `wstack version`, `wstack mailbox serve`, the TUI host, and each daemon that
 * shells out through the CLI. Anything reachable by a STATIC import from that
 * entry is paid for unconditionally.
 *
 * Two things make this easy to regress silently:
 *
 *  1. The CLI is built with `splitting: true` (scripts/build-package.mjs). With
 *     splitting OFF, esbuild inlines dynamically-imported in-repo modules into
 *     the single output file and hoists THEIR external imports to the top, so
 *     an `await import('./x.js')` defers nothing when `x.ts` imports a
 *     workspace package. If someone turns splitting off, these assertions fail.
 *  2. One static import anywhere in the always-loaded graph is enough. That is
 *     exactly how `@wrongstack/webui-server` used to load on every invocation:
 *     `webui-server.ts` was already imported lazily from `boot/dispatch-webui.ts`,
 *     but `execution.ts` statically imported `./webui-server/kanban-run-mirror.js`,
 *     which re-exports from the package.
 *
 * A source-level grep cannot express either condition; only the emitted entry
 * bundle can, which is why this reads `dist/`.
 */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Repo root resolved from this file (packages/cli/tests/architecture/) so the
// suite passes from the repo root AND from the package cwd.
const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const ENTRY = path.join(repositoryRoot, 'packages', 'cli', 'dist', 'index.js');

// The assertions below read the emitted entry bundle and dist/ contents, so a
// missing dist is a setup failure, not a pass. Guarded once in beforeAll so
// every test in this suite fails with the fix command instead of a bare
// ENOENT from deep inside fs.readFile/fs.readdir.
const MISSING_DIST_MESSAGE = [
  'packages/cli/dist/index.js was not found.',
  'The boot-graph assertions read the emitted entry bundle, so build the CLI first:',
  '  pnpm --filter @wrongstack/cli build      (or workspace-wide: pnpm build)',
].join('\n');

/**
 * Packages that must never be reachable by a static import from the entry.
 * Each is only needed on a path the CLI may never take, and each is expensive:
 * the measured standalone cost is in the comment.
 */
const MUST_BE_LAZY = [
  '@wrongstack/webui-server', // 80.2MB RSS standalone — WebUI is off by default
  '@wrongstack/bench', // 5.5MB — only reachable from the `bench` subcommand
  // These five hang off the interactive wiring layer, which `cli-entry-main.ts`
  // loads only after `initializeCli()` declines to short-circuit. Standalone
  // RSS in comments; a static edge to any of them means a subcommand-only or
  // `mailbox serve` invocation is paying for a full interactive session.
  '@wrongstack/sdd', // 21.3MB
  '@wrongstack/acp', // 21.2MB
  '@wrongstack/sage', // 19.8MB
  '@wrongstack/mcp', // 11.3MB
  '@wrongstack/security-scanner', // 7.5MB
];

/**
 * The always-loaded graph should stay small. This is a ratchet, not a precise
 * target: it was 270 modules before the `cli-entry-main.ts` split and 27 after,
 * so anything approaching the old number means the boundary was breached by a
 * new static import somewhere in `cli-context.ts` / `boot.ts`.
 */
const MAX_ENTRY_MODULES = 60;

function staticSpecifiers(source: string): Set<string> {
  const found = new Set<string>();
  // `import ... from "x"` / `export ... from "x"`. The class after the keyword
  // must allow `{` and `*` with no space: esbuild emits `import{a}from"x"` and
  // `import*as ns from"x"`.
  const fromForm = /(?:^|[\s;}])(?:import|export)[\s{*][^;]*?from\s*["']([^"']+)["']/gmu;
  // Bare side-effect import: `import "x";`
  const bareForm = /(?:^|[\s;}])import\s*["']([^"']+)["']/gmu;
  for (const re of [fromForm, bareForm]) {
    let match: RegExpExecArray | null = re.exec(source);
    while (match) {
      if (match[1]) found.add(match[1]);
      match = re.exec(source);
    }
  }
  return found;
}

describe('CLI boot graph boundary', () => {
  beforeAll(() => {
    if (!existsSync(ENTRY)) throw new Error(MISSING_DIST_MESSAGE);
  });

  it('does not statically import packages that only some invocations need', async () => {
    const source = await fs.readFile(ENTRY, 'utf8');
    // A missing/empty dist is a setup failure, not a pass — the beforeAll
    // guard above fails with build instructions instead of a bare ENOENT.
    expect(source.length).toBeGreaterThan(1000);

    const specifiers = staticSpecifiers(source);
    const offenders = MUST_BE_LAZY.filter((pkg) => specifiers.has(pkg));
    expect(offenders).toEqual([]);
  });

  it('keeps the always-loaded module graph small', async () => {
    const source = await fs.readFile(ENTRY, 'utf8');
    // esbuild leaves a `// src/foo.ts` marker above each inlined module.
    const modules = source.match(/^\/\/ src\/.+$/gmu) ?? [];
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.length).toBeLessThanOrEqual(MAX_ENTRY_MODULES);
  });

  it('emits real chunks, so dynamic imports actually defer', async () => {
    // If `splitting` is turned off for @wrongstack/cli, esbuild produces no
    // chunk files and every `await import()` above collapses back into the
    // entry — the first assertion would then be the only thing standing, and
    // it would fail for a confusing reason. Assert the cause directly.
    const dist = path.join(repositoryRoot, 'packages', 'cli', 'dist');
    const names = await fs.readdir(dist);
    expect(names.some((name) => /^chunk-.*\.js$/u.test(name))).toBe(true);
  });

  it('keeps the shebang on the entry only', async () => {
    // esbuild applies `banner` to every output; a shebang is only meaningful on
    // the executable entry. build-package.mjs strips it from the rest.
    const dist = path.join(repositoryRoot, 'packages', 'cli', 'dist');
    const names = (await fs.readdir(dist)).filter((n) => n.endsWith('.js'));
    const withShebang: string[] = [];
    for (const name of names) {
      const head = (await fs.readFile(path.join(dist, name), 'utf8')).slice(0, 2);
      if (head === '#!') withShebang.push(name);
    }
    expect(withShebang).toEqual(['index.js']);
  });
});
