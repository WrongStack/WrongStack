/**
 * The TypeScript compiler (`@typescript/typescript6`, ~9MB of JavaScript) must
 * never be reachable through a STATIC import from a built bundle.
 *
 * Measured cost of evaluating it: ~19MB heap / ~27MB RSS per process. It used
 * to sit in the module graph of every bundle that could reach the codebase
 * indexer, so `wstack version`, `wstack mailbox serve` and the codebase-index
 * project server — none of which parse TypeScript — all paid it at boot.
 *
 * This regressed once already: `parser-dispatch.ts` was written specifically to
 * keep the parsers lazy, and `indexer.ts` quietly re-introduced a static
 * `import { parseSymbols } from './ts-parser.js'` that defeated it. A source
 * grep alone would not have caught the second half of the problem either — the
 * build runs with `splitting: false`, so esbuild INLINES dynamic imports of
 * in-repo files. Only the emitted bundles tell the truth, which is why this
 * test inspects `dist/`.
 */
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = path.join(process.cwd(), 'packages', 'tools', 'dist');
const TS_PACKAGE = '@typescript/typescript6';

/**
 * `import ... from "@typescript/typescript6"` / `export ... from "..."` — static
 * only. The character class after `import` must allow `{` and `*` with no
 * whitespace: esbuild emits `import{x}from"pkg"` and `import*as ts from"pkg"`.
 */
const STATIC_IMPORT = new RegExp(
  String.raw`(?:^|[\s;}])(?:import|export)[\s{*][^;]*?from\s*["']${TS_PACKAGE.replace('/', '\\/')}["']`,
  'mu',
);
/** A bare side-effect import is static too: `import "@typescript/typescript6";` */
const BARE_IMPORT = new RegExp(
  String.raw`(?:^|[\s;}])import\s*["']${TS_PACKAGE.replace('/', '\\/')}["']`,
  'mu',
);

async function bundles(dir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await bundles(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(absolute);
  }
  return out;
}

describe('TypeScript compiler load boundary', () => {
  it('is never a static import in any built @wrongstack/tools bundle', async () => {
    const files = await bundles(DIST);
    // A missing dist means the package was not built; that is a setup problem,
    // not a passing test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      if (STATIC_IMPORT.test(source) || BARE_IMPORT.test(source)) {
        offenders.push(path.relative(process.cwd(), file).replaceAll('\\', '/'));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still reaches the compiler through a runtime import()', async () => {
    // Guards the opposite failure: silently dropping TS parsing altogether
    // would also make the test above pass.
    const files = await bundles(DIST);
    const withDynamic = [] as string[];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes(`import("${TS_PACKAGE}")`)) {
        withDynamic.push(path.relative(process.cwd(), file).replaceAll('\\', '/'));
      }
    }
    expect(withDynamic.length).toBeGreaterThan(0);
  });
});
