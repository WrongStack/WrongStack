import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The site builds from the workspace bun.lock, but website/package-lock.json is what npm and the
 * CI npm audit read. A dependency bump that edits package.json and bun.lock alone leaves it
 * behind, and `npm ci` then refuses it ("package.json and package-lock.json are in sync").
 * Fix a failure here with `npm install --package-lock-only --workspaces=false` in website/.
 */

type Deps = Record<string, string>;
const websiteRoot = process.cwd();
const manifest: { dependencies?: Deps; devDependencies?: Deps } = JSON.parse(
  readFileSync(resolve(websiteRoot, 'package.json'), 'utf8'),
);
const lock: {
  packages: Record<string, { version?: string; dependencies?: Deps; devDependencies?: Deps }>;
} = JSON.parse(readFileSync(resolve(websiteRoot, 'package-lock.json'), 'utf8'));
const lockRoot = lock.packages[''] ?? {};

function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** npm's reading of `^x.y.z`, `~x.y.z` and exact `x.y.z`; any other range is not judged here. */
function satisfies(version: string, range: string): boolean | undefined {
  const operator = range.startsWith('^') ? '^' : range.startsWith('~') ? '~' : '';
  const floor = parse(range.slice(operator.length));
  const actual = parse(version);
  if (!floor || !actual || !/^[\^~]?\d+\.\d+\.\d+$/.test(range)) return undefined;
  if (!operator) return compare(actual, floor) === 0;
  if (compare(actual, floor) < 0 || actual[0] !== floor[0]) return false;
  const pinMinor = operator === '~' || floor[0] === 0;
  const pinPatch = operator === '^' && floor[0] === 0 && floor[1] === 0;
  return (!pinMinor || actual[1] === floor[1]) && (!pinPatch || actual[2] === floor[2]);
}

describe('website npm lockfile', () => {
  it('records the ranges package.json declares', () => {
    expect(lockRoot.dependencies ?? {}).toEqual(manifest.dependencies ?? {});
    expect(lockRoot.devDependencies ?? {}).toEqual(manifest.devDependencies ?? {});
  });

  it('resolves every direct dependency to a version its range accepts', () => {
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    const unsatisfied = Object.entries(declared).flatMap(([name, range]) => {
      const version = lock.packages[`node_modules/${name}`]?.version;
      if (version === undefined) return [`${name}: not in the lockfile`];
      return satisfies(version, range) === false ? [`${name}: ${version} outside ${range}`] : [];
    });
    expect(unsatisfied).toEqual([]);
  });
});
