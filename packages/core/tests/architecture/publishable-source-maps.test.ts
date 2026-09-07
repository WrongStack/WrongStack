// Regression for I5 (SC-SUPPLY-007): the 34 package manifests under
// packages/ carry an exclusion (a leading-bang entry) in their
// `files` block that omits the generated dist source map. The JS is
// shipped but the matching .map is not, so a consumer cannot read
// the original TypeScript sources. apps/desktop and apps/wrongstack
// did not carry the same exclusion and so shipped maps, including a
// 246 KB Electron-main map that makes the main/preload IPC boundary
// trivially readable.
//
// This test enumerates every package.json whose `private` is not
// `true` (i.e. that npm actually publishes) and asserts the exclusion
// is present.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function findPackageJsonFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name === 'package.json' && !p.includes('/node_modules/')) {
        out.push(p);
      }
    }
  }
  for (const top of ['packages', 'apps']) {
    walk(join(repoRoot, top));
  }
  return out;
}

describe('I5 / publishable manifests omit dist source maps', () => {
  for (const pkgPath of findPackageJsonFiles()) {
    it(`${pkgPath.slice(repoRoot.length + 1).replace(/\\/g, '/')}`, () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        private?: boolean;
        files?: string[];
      };
      if (pkg.private === true) return; // never published
      const files = pkg.files ?? [];
      // The 34 package manifests pin a `!dist/**/*.map` exclusion; the
      // two `apps/*` manifests were the offenders. A new publishable
      // manifest must follow suit.
      expect(
        files.some((f) => /dist.*\.map/.test(f) && f.startsWith('!')),
        `${pkgPath} is publishable (private !== true) but its \`files\` block does not exclude \`dist/**/*.map\` — the tarball would ship TypeScript source maps alongside the compiled JS`,
      ).toBe(true);
    });
  }
});
