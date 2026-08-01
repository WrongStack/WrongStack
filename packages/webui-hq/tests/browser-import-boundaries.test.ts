import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(import.meta.dirname, '../src');
const runtimeHqBarrelPattern =
  /\b(?:import|export)\s+(?!type\b)[^;]*\bfrom\s+['"]@wrongstack\/core\/hq['"]/;

function browserSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return browserSourceFiles(absolutePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

describe('HQ browser import boundaries', () => {
  it('keeps the Node-only HQ barrel out of browser runtime code', () => {
    const violations = browserSourceFiles(srcRoot)
      .filter((file) => runtimeHqBarrelPattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file));

    expect(violations).toEqual([]);
  });
});
