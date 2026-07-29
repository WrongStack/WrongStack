/**
 * Tests for dead-code-scan using the codebase-index refs graph.
 *
 * Spins up a small project with known entry points and dead symbols,
 * indexes it, then verifies the scan correctly classifies each symbol.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeadCodeScan } from '../src/codebase-index/dead-code-scan.js';
import { indexStorePool } from '../src/codebase-index/writer.js';
import { runIndexer } from '../src/codebase-index/indexer.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-deadcode-'));
});

afterEach(async () => {
  indexStorePool.evict(dir, path.join(dir, '.codebase-index'));
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
  const full = path.join(dir, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

describe('runDeadCodeScan', () => {
  it('classifies a dead export as unreferenced when nothing imports it', async () => {
    await write('package.json', JSON.stringify({ name: 'test-pkg' }));
    // Entry point: exports one function and calls it.
    await write(
      'src/index.ts',
      `import { used } from './used';
       export function entry() { used(); }
      `,
    );
    // Used module: has one used export + one dead export
    await write(
      'src/used.ts',
      `export function used() { return 1; }
       export function dead_never_called() { return 2; }
      `,
    );
    // Single file with only a dead export.
    await write(
      'src/also-dead.ts',
      `export function also_dead() { return 3; }
       export const DEAD_CONST = 4;
      `,
    );

    await runIndexer({} as never, { projectRoot: dir, indexDir: indexDir() });

    const store = indexStorePool.acquire(dir, { indexDir: indexDir() });
    const result = runDeadCodeScan(dir, { store });
    indexStorePool.release(store);

    // used() should be alive (imported in index.ts)
    const used = result.deadSymbols.filter((s) => s.name === 'used');
    expect(used).toHaveLength(0);

    // dead_never_called should be dead
    const deadNever = result.deadSymbols.filter(
      (s) => s.name === 'dead_never_called',
    );
    expect(deadNever).toHaveLength(1);
    expect(deadNever[0]!.reason).toBe('unreferenced');

    // also_dead should be dead
    const alsoDead = result.deadSymbols.filter(
      (s) => s.name === 'also_dead',
    );
    expect(alsoDead).toHaveLength(1);

    // DEAD_CONST should be dead
    const deadConst = result.deadSymbols.filter(
      (s) => s.name === 'DEAD_CONST',
    );
    expect(deadConst).toHaveLength(1);

    // Stats sanity
    expect(result.stats.dead).toBeGreaterThanOrEqual(3);
    expect(result.stats.alive).toBeGreaterThanOrEqual(1);
    expect(result.entryPoints.length).toBeGreaterThanOrEqual(1);
  });

  it('traverses transitive imports to keep indirectly-referenced symbols alive', async () => {
    await write('package.json', JSON.stringify({ name: 'test-pkg' }));
    await write(
      'src/index.ts',
      `import { a } from './a';
       export function entry() { a(); }
      `,
    );
    await write(
      'src/a.ts',
      `import { b } from './b';
       export function a() { b(); }
      `,
    );
    await write(
      'src/b.ts',
      `import { c } from './c';
       export function b() { c(); }
      `,
    );
    await write(
      'src/c.ts',
      `export function c() { return 1; }
       export function orphan() { return 2; }
      `,
    );

    await runIndexer({} as never, { projectRoot: dir, indexDir: indexDir() });

    const store = indexStorePool.acquire(dir, { indexDir: indexDir() });
    const result = runDeadCodeScan(dir, { store });
    indexStorePool.release(store);

    expect(result.deadSymbols.filter((s) => s.name === 'a')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'b')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'c')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'orphan')).toHaveLength(1);
  });

  it('discovers entry points from pnpm-workspace.yaml when package.json has no workspaces field', async () => {
    // Root package.json with no workspaces field — pnpm monorepo pattern.
    await write('package.json', JSON.stringify({ name: 'test-mono' }));
    // pnpm-workspace.yaml listing two workspace dirs.
    await write(
      'pnpm-workspace.yaml',
      `packages:
  - "packages/*"
  - "apps/*"
onlyBuiltDependencies:
  - electron
  - esbuild
`,
    );
    // Workspace package with package.json + conventional entry point.
    await write(
      'packages/lib/package.json',
      JSON.stringify({ name: '@test/lib', main: './dist/index.js' }),
    );
    await write(
      'packages/lib/src/index.ts',
      `import { greet } from './greet';
       export function entry() { greet(); }
      `,
    );
    await write(
      'packages/lib/src/greet.ts',
      `export function greet() { return 'hello'; }
       export function unused() { return 'dead'; }
      `,
    );
    // apps/web package with just a convention entry point.
    await write(
      'apps/web/package.json',
      JSON.stringify({ name: '@test/web' }),
    );
    await write(
      'apps/web/src/main.ts',
      `export function webEntry() { return 42; }
      `,
    );

    await runIndexer({} as never, { projectRoot: dir, indexDir: indexDir() });

    const store = indexStorePool.acquire(dir, { indexDir: indexDir() });
    const result = runDeadCodeScan(dir, { store });
    indexStorePool.release(store);

    // Should have discovered entry points from workspace packages.
    expect(result.entryPoints.length).toBeGreaterThanOrEqual(2);
    // entry() and greet() should be alive; unused() should be dead.
    expect(result.deadSymbols.filter((s) => s.name === 'entry')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'greet')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'unused')).toHaveLength(1);
    // webEntry should also be alive (src/main.ts convention hit).
    expect(result.deadSymbols.filter((s) => s.name === 'webEntry')).toHaveLength(0);
  });

  it('ignores non-packages sections in pnpm-workspace.yaml (regression)', async () => {
    // Multi-section pnpm-workspace.yaml mirroring a real project layout.
    // Only items under the `packages:` key should be treated as workspace
    // globs — items under `onlyBuiltDependencies`, `auditConfig.ignoreGhsas`,
    // and other top-level keys must be ignored.
    await write('package.json', JSON.stringify({ name: 'test-mono' }));
    await write(
      'pnpm-workspace.yaml',
      [
        'packages:',
        '  - "packages/*"',
        '  - "apps/*"',
        'overrides:',
        '  dompurify: ">=3.4.11"',
        '  esbuild: "^0.28.1"',
        'auditConfig:',
        '  ignoreGhsas:',
        '    - GHSA-gv7w-rqvm-qjhr',
        'allowBuilds:',
        "  '@biomejs/biome': true",
        '  better-sqlite3: true',
        '  electron: true',
        'onlyBuiltDependencies:',
        '  - "@biomejs/biome"',
        '  - better-sqlite3',
        '  - electron',
        '  - esbuild',
        '  - node-pty',
        'minimumReleaseAgeExclude:',
        '  - electron@43.0.0',
        '',
      ].join('\n'),
    );

    // Legitimate workspace packages.
    await write(
      'packages/lib/package.json',
      JSON.stringify({ name: '@test/lib' }),
    );
    await write(
      'packages/lib/src/index.ts',
      `export function libFn() {}`,
    );

    await write(
      'apps/web/package.json',
      JSON.stringify({ name: '@test/web' }),
    );
    await write(
      'apps/web/src/main.ts',
      `export function webFn() {}`,
    );

    // Trap directory: 'electron' appears in both onlyBuiltDependencies and
    // allowBuilds. Create it as a real directory with a package.json so the
    // old code (global regex matching ALL list items) would incorrectly
    // discover it as a workspace entry point. The fixed code must ignore it.
    await write(
      'electron/package.json',
      JSON.stringify({ name: 'electron' }),
    );
    await write(
      'electron/src/index.ts',
      `export function electronTrap() {}`,
    );

    await runIndexer({} as never, { projectRoot: dir, indexDir: indexDir() });

    const store = indexStorePool.acquire(dir, { indexDir: indexDir() });
    const result = runDeadCodeScan(dir, { store });
    indexStorePool.release(store);

    // Legitimate workspace entry points must be found.
    // Use path.join for cross-platform separator compatibility.
    const entryPaths = result.entryPoints;
    const hasLibPath = entryPaths.some((p) =>
      p.includes(path.join('packages', 'lib')),
    );
    const hasWebPath = entryPaths.some((p) =>
      p.includes(path.join('apps', 'web')),
    );
    expect(hasLibPath).toBe(true);
    expect(hasWebPath).toBe(true);

    // Trap directory must NOT appear in entry points — if it does, the
    // pnpm-workspace.yaml parser is picking up items from non-packages keys.
    const hasTrapPath = entryPaths.some((p) =>
      p.includes(path.join('electron')),
    );
    expect(hasTrapPath).toBe(false);
  });

  it('excludes local variables (let, var) from dead symbol reports', async () => {
    await write('package.json', JSON.stringify({ name: 'test-pkg' }));
    await write(
      'src/index.ts',
      `import { helper } from './helper';
       helper();
      `,
    );
    await write(
      'src/helper.ts',
      `export function helper() {
         let localVar = 1;
         const localConst = 2;
         var localVar2 = 3;
         return localVar;
       }
       export function also_dead() {}
      `,
    );

    await runIndexer({} as never, { projectRoot: dir, indexDir: indexDir() });

    const result = runDeadCodeScan(dir, {
      store: indexStorePool.acquire(dir, { indexDir: indexDir() }),
    });

    // also_dead should be flagged as dead
    expect(result.deadSymbols.filter((s) => s.name === 'also_dead')).toHaveLength(1);
    // localVar and localConst should NOT appear in dead symbols
    expect(result.deadSymbols.filter((s) => s.name === 'localVar')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'localConst')).toHaveLength(0);
    expect(result.deadSymbols.filter((s) => s.name === 'localVar2')).toHaveLength(0);
  });
});

function indexDir(): string {
  return path.join(dir, '.codebase-index');
}
