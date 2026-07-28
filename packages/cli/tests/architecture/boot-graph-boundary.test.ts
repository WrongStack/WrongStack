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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRY = path.join(process.cwd(), 'packages', 'cli', 'dist', 'index.js');

/**
 * Packages that must never be reachable by a static import from the entry.
 * Each is only needed on a path the CLI may never take, and each is expensive:
 * the measured standalone cost is in the comment.
 */
const MUST_BE_LAZY = [
  '@wrongstack/webui-server', // +38.7MB heap / +80.2MB RSS — WebUI is off by default
  '@wrongstack/bench', // only reachable from the `bench` subcommand
];

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
  it('does not statically import packages that only some invocations need', async () => {
    const source = await fs.readFile(ENTRY, 'utf8');
    // A missing/empty dist is a setup failure, not a pass.
    expect(source.length).toBeGreaterThan(1000);

    const specifiers = staticSpecifiers(source);
    const offenders = MUST_BE_LAZY.filter((pkg) => specifiers.has(pkg));
    expect(offenders).toEqual([]);
  });

  it('emits real chunks, so dynamic imports actually defer', async () => {
    // If `splitting` is turned off for @wrongstack/cli, esbuild produces no
    // chunk files and every `await import()` above collapses back into the
    // entry — the first assertion would then be the only thing standing, and
    // it would fail for a confusing reason. Assert the cause directly.
    const dist = path.join(process.cwd(), 'packages', 'cli', 'dist');
    const names = await fs.readdir(dist);
    expect(names.some((name) => /^chunk-.*\.js$/u.test(name))).toBe(true);
  });

  it('keeps the shebang on the entry only', async () => {
    // esbuild applies `banner` to every output; a shebang is only meaningful on
    // the executable entry. build-package.mjs strips it from the rest.
    const dist = path.join(process.cwd(), 'packages', 'cli', 'dist');
    const names = (await fs.readdir(dist)).filter((n) => n.endsWith('.js'));
    const withShebang: string[] = [];
    for (const name of names) {
      const head = (await fs.readFile(path.join(dist, name), 'utf8')).slice(0, 2);
      if (head === '#!') withShebang.push(name);
    }
    expect(withShebang).toEqual(['index.js']);
  });
});
