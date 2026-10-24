import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const CORE_SRC = path.join(REPO_ROOT, 'packages/core/src');

/** Core build entries, read from the `coreEntries` list in build-package.mjs. */
function coreEntries(): Set<string> {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-package.mjs'), 'utf8');
  const start = script.indexOf('const coreEntries = entryMap([');
  const end = script.indexOf(']);', start);
  expect(start).toBeGreaterThan(-1);
  const block = script.slice(start, end);
  return new Set([...block.matchAll(/'(src\/[^']+\.tsx?)'/gu)].map((match) => match[1] ?? ''));
}

function* sources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

describe('core star re-exports of external packages', () => {
  it('only appear in build entries, where esbuild keeps them', () => {
    // esbuild drops `export * from '<external package>'` from a module that is
    // not an entry point, so its bindings silently vanish from dist while
    // typecheck and source-aliased tests still pass. On 2026-10-24 this left
    // `@wrongstack/core/agent-catalog` without runtimeToolReferencesFromText
    // and broke the standalone binary link. Use named re-exports instead.
    const entries = coreEntries();
    const offenders: string[] = [];
    for (const file of sources(CORE_SRC)) {
      const rel = path
        .relative(path.join(REPO_ROOT, 'packages/core'), file)
        .split(path.sep)
        .join('/');
      if (entries.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/^export\s+\*\s+from\s+['"][^.'"][^'"]*['"]/mu.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
