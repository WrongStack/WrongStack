/**
 * WS-086 — published tarballs must not carry source maps.
 *
 * `build-package.mjs` defaults `sourcemap` to true (one branch says false, the
 * other true — they disagreed), and every publishable package lists `dist` in
 * `files`, so 217 `.js.map` files totalling ~61.6 MB with full `sourcesContent`
 * shipped to npm across 27 packages. The repo is MIT, so this is package
 * hygiene rather than secret disclosure — but core's own manifest comment says
 * only `dist/` ships, and 61 MB of embedded TypeScript is not what "dist"
 * means to anyone reading it.
 *
 * Maps are still produced locally, where they are useful for stack traces; they
 * are excluded from the tarball via a `files` negation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const packagesDir = path.join(repoRoot, 'packages');

function publishableManifests(): { name: string; files: string[] }[] {
  return fs
    .readdirSync(packagesDir)
    .map((dir) => path.join(packagesDir, dir, 'package.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    .filter((pkg) => pkg['private'] !== true && Array.isArray(pkg['files']))
    .map((pkg) => ({ name: String(pkg['name']), files: pkg['files'] as string[] }));
}

describe('published package artifacts', () => {
  it('finds the publishable packages (guards against a vacuous pass)', () => {
    expect(publishableManifests().length).toBeGreaterThan(20);
  });

  it('every package that ships dist/ excludes source maps from the tarball', () => {
    const offenders = publishableManifests()
      .filter((pkg) => pkg.files.includes('dist'))
      .filter((pkg) => !pkg.files.includes('!dist/**/*.map'))
      .map((pkg) => pkg.name);

    expect(offenders).toEqual([]);
  });
});
