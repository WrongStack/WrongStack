import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SCAN_ROOTS = ['packages', 'apps'];
const CHRONICLE_AUTHORITY = 'packages/core/src/chronicle/';

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionTypeScriptFiles(absolute)));
    else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe('Chronicle project ownership boundary', () => {
  it('keeps journal, query engine, and metrics storage behind the Chronicle gateway', async () => {
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionTypeScriptFiles(path.join(ROOT, directory))),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      if (relative.startsWith(CHRONICLE_AUTHORITY)) continue;
      const source = await fs.readFile(file, 'utf8');
      if (/new\s+ChronicleJournal\s*\(/u.test(source)) {
        violations.push(`${relative}: constructs the authoritative journal`);
      }
      if (/ChronicleQueryEngine\s*\.\s*from(?:Directory|Files)\s*\(/u.test(source)) {
        violations.push(`${relative}: reads journal partitions directly`);
      }
      if (/ChronicleMetricsStore\s*\.\s*open\s*\(/u.test(source)) {
        violations.push(`${relative}: opens derived metrics storage directly`);
      }
    }

    expect(violations).toEqual([]);
  });
});
