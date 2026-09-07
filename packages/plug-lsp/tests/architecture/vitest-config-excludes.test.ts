/**
 * Regression (proof-driven bug-hunter round 20260907-r2): the coverage
 * excludes in this package's vitest.config.ts AND the root vitest.config.ts
 * listed seven plug-lsp source files that do not exist on disk
 * (`src/tools/lsp-search.ts`, `src/tools/codebase-index/index.ts`, and five
 * `src/auto-doc/*-parser.ts`). Dead entries make the coverage manifest lie
 * about what is managed and mislead maintainers.
 *
 * Guard: every concrete plug-lsp exclude in both configs must reference a
 * real file, and the live excludes must remain present. Imports the real
 * config objects — no text parsing.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '../..');
const rootDir = resolve(pkgDir, '../..');

// Absolute file URLs: (1) the test tsconfig lacks allowImportingTsExtensions,
// so a literal '.ts' specifier would raise TS5097, and (2) relative dynamic
// specifiers resolved ambiguously under vite-node — the file URL pins each
// import to exactly one real config module at runtime.
const pkgConfigUrl = pathToFileURL(resolve(pkgDir, 'vitest.config.ts')).href;
const rootConfigUrl = pathToFileURL(resolve(rootDir, 'vitest.config.ts')).href;
const pkgMod = await import(pkgConfigUrl);
const rootMod = await import(rootConfigUrl);

const scopes = [
  {
    label: 'packages/plug-lsp/vitest.config.ts',
    entries: (pkgMod.default as { test?: { coverage?: { exclude?: string[] } } }).test?.coverage
      ?.exclude,
    dir: pkgDir,
    scoped: (entry: string) => entry.startsWith('src/'),
    live: ['src/index.ts', 'src/types.ts', 'src/tools/codebase-lsp-search.ts'],
  },
  {
    label: 'vitest.config.ts (root)',
    entries: (rootMod.default as { test?: { coverage?: { exclude?: string[] } } }).test?.coverage
      ?.exclude,
    dir: rootDir,
    scoped: (entry: string) => entry.startsWith('packages/plug-lsp/'),
    live: ['packages/plug-lsp/src/tools/codebase-lsp-search.ts'],
  },
] as const;

describe('coverage exclude manifest matches the file tree (round 20260907-r2)', () => {
  for (const scope of scopes) {
    it(`${scope.label}: every concrete plug-lsp exclude references an existing file`, () => {
      const entries = scope.entries ?? [];
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.every((entry) => typeof entry === 'string')).toBe(true);
      const missing = entries
        .filter((entry) => scope.scoped(entry) && !/[*?]/.test(entry))
        .filter((entry) => !existsSync(resolve(scope.dir, entry)));
      expect(missing).toEqual([]);
    });

    it(`${scope.label}: live excludes remain`, () => {
      for (const entry of scope.live) {
        expect(scope.entries ?? []).toContain(entry);
      }
    });
  }
});
