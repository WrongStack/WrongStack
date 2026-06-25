import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const KERNEL_SRC = path.resolve(process.cwd(), 'packages/core/src/kernel');
const CORE_SRC = path.resolve(process.cwd(), 'packages/core/src');

const IMPORT_RE = /(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const HIGH_LEVEL_DIRS = new Set([
  'autophase',
  'coordination',
  'core',
  'execution',
  'extension',
  'hooks',
  'hq',
  'infrastructure',
  'middleware',
  'models',
  'observability',
  'plugin',
  'plugins',
  'registry',
  'replay',
  'sdd',
  'security',
  'security-scanner',
  'skills',
  'storage',
  'tools',
  'worktree',
]);

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function isTypeOnlyImport(line: string): boolean {
  const withoutLineComment = line.replace(/\/\/.*$/, '');
  return /\bimport\s+type\b/.test(withoutLineComment);
}

function sourceDirForImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const relativeToCore = path.relative(CORE_SRC, resolved);
  if (relativeToCore.startsWith('..') || path.isAbsolute(relativeToCore)) return null;

  const firstSegment = relativeToCore.split(path.sep)[0];
  return firstSegment ?? null;
}

describe('kernel import boundary', () => {
  it('does not take runtime imports from high-level core layers', async () => {
    const violations: string[] = [];

    for (const file of await walk(KERNEL_SRC)) {
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        IMPORT_RE.lastIndex = 0;
        for (const match of line.matchAll(IMPORT_RE)) {
          const specifier = match[1] ?? match[2] ?? match[3];
          if (!specifier || isTypeOnlyImport(line)) continue;

          const targetDir = sourceDirForImport(file, specifier);
          if (!targetDir || targetDir === 'kernel' || targetDir === 'types' || targetDir === 'utils') {
            continue;
          }

          if (HIGH_LEVEL_DIRS.has(targetDir)) {
            violations.push(
              `${path.relative(process.cwd(), file)} -> ${specifier} (${targetDir}/): kernel runtime import boundary violation`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
