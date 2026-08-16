import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SCAN_ROOTS = ['packages', 'apps'];
const ADAPTER_AUTHORITY = 'packages/sage/src/memory-port.ts';

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionTypeScriptFiles(absolute)));
    else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe('MemoryPort ownership boundary', () => {
  it('prohibits new production callers of concrete backends and local capability guessing', async () => {
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionTypeScriptFiles(path.join(ROOT, directory))),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      if (relative === ADAPTER_AUTHORITY) continue;
      const source = await fs.readFile(file, 'utf8');
      if (/new\s+(?:SageStore|SqliteSageStore)\s*\(/u.test(source)) {
        violations.push(`${relative}: constructs a concrete memory backend`);
      }
      if (/function\s+isSage(?:Store|Retriever)\s*\(/u.test(source)) {
        violations.push(`${relative}: defines a local SAGE capability guard`);
      }
      if (/as\s+unknown\s+as\s+MemoryStore\b/u.test(source)) {
        violations.push(`${relative}: uses an unsafe MemoryStore contract cast`);
      }
    }

    expect(violations).toEqual([]);
  });
});
