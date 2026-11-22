/**
 * Parser worker-pool failover (P3.7) — driven against the REAL pool class
 * with REAL spawned workers.
 *
 * The pool resolves the compiled worker script relative to its own module
 * location, which from `src/` finds nothing — so these tests point it at
 * the built artifact via `WRONGSTACK_PARSER_WORKER_SCRIPT` (a seam added
 * for exactly this) and skip when the build is absent, like the sibling
 * dist-gated suites.
 *
 * What is proven here:
 *  1. A mid-batch death of ONE worker does not hang the batch: its chunk is
 *     re-parsed inline on the main thread and every file comes back.
 *     (Before P3.7 this hung until the 60s/240s indexer watchdog.)
 *  2. Salvaged results are complete — no file silently drops when a fast
 *     surviving worker finishes before the salvage does.
 *  3. Death of EVERY worker rejects the batch (the indexer's existing catch
 *     then re-parses inline); it never resolves empty.
 *  4. The pool stays usable after a partial death (next batch succeeds).
 */
import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ParserWorkerPool } from '../src/codebase-index/parser-worker-pool.js';
import type { SymbolLang } from '../src/codebase-index/schema.js';

const distWorker = fileURLToPath(
  new URL('../dist/codebase-index/parser-worker-script.js', import.meta.url),
);
const distReady = fsSync.existsSync(distWorker);
if (distReady) {
  // The source-imported pool probes for the worker relative to src/, where
  // nothing is built — point it at the dist artifact via the override seam.
  process.env['WRONGSTACK_PARSER_WORKER_SCRIPT'] = distWorker;
}

interface TestFile {
  file: string;
  content: string;
  lang: SymbolLang;
}

function makeFiles(count: number, marker: string): TestFile[] {
  const files: TestFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      file: `D:/virtual/${marker}/file-${i}.ts`,
      content:
        `/** ${marker} module ${i} for failover verification. */\n` +
        `export function ${marker}Fn${i}(a: number): number { return a + ${i}; }\n` +
        `export const ${marker}Val${i} = ${i};\n`,
      lang: 'ts',
    });
  }
  return files;
}

const pools: ParserWorkerPool[] = [];

function newPool(): ParserWorkerPool {
  const pool = new ParserWorkerPool(4);
  pools.push(pool);
  return pool;
}

async function killOneBusyWorker(pool: ParserWorkerPool): Promise<void> {
  // Terminate the first spawned worker thread. Whichever chunk it holds
  // becomes the orphaned chunk under test.
  const workers = (
    pool as unknown as { workers: Array<{ worker: { terminate(): Promise<unknown> } }> }
  ).workers;
  expect(workers.length).toBeGreaterThan(1);
  const victim = workers[0]!.worker;
  await victim.terminate();
}

async function killAllWorkers(pool: ParserWorkerPool): Promise<void> {
  const workers = (
    pool as unknown as { workers: Array<{ worker: { terminate(): Promise<unknown> } }> }
  ).workers;
  await Promise.all(workers.map((w) => w.worker.terminate()));
}

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown().catch(() => undefined);
});

// Process-hold cases: the pool must never hold its process open (module
// contract: "Workers are unref()'d so they don't keep the process alive"),
// yet must keep it alive while a batch or a shutdown is still awaited.
// Each runs in a child process that reports how long the process stayed up
// after its last awaited step.
const poolModule = fileURLToPath(
  new URL('../../codebase/src/parser-worker-pool.ts', import.meta.url),
);
const holdDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ws-parser-pool-hold-'));
afterAll(() => fsSync.rmSync(holdDir, { recursive: true, force: true }));

function processExitDelay(mode: 'idle' | 'shutdown'): {
  ready: boolean;
  delay: number | undefined;
} {
  const file = path.join(holdDir, `${mode}.ts`);
  fsSync.writeFileSync(
    file,
    `process.env['WRONGSTACK_PARSER_WORKER_SCRIPT'] = ${JSON.stringify(distWorker)};
const { ParserWorkerPool } = await import(${JSON.stringify(pathToFileURL(poolModule).href)});
const pool = new ParserWorkerPool(2);
if (!(await pool.ensureReady())) process.exit(3);
const out = await pool.parseFiles([
  { file: 'D:/virtual/a.ts', content: 'export const a = 1;\\n', lang: 'ts' },
  { file: 'D:/virtual/b.ts', content: 'export const b = 2;\\n', lang: 'ts' },
]);
if (out.length !== 2) process.exit(4);
${mode === 'shutdown' ? 'await pool.shutdown();' : ''}
console.log('READY');
const t0 = performance.now();
process.on('exit', () => console.log('EXIT_DELAY_MS=' + Math.round(performance.now() - t0)));
`,
  );
  // A .ts child needs Bun, or Node with the tsx loader.
  const args = process.versions.bun ? [file] : ['--import', 'tsx', file];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 8_000 });
  const match = /EXIT_DELAY_MS=(\d+)/.exec(res.stdout ?? '');
  return { ready: /READY/.test(res.stdout ?? ''), delay: match ? Number(match[1]) : undefined };
}

describe.runIf(distReady)('parser worker-pool failover (dist worker)', () => {
  it('resolves a batch with complete results when one worker dies mid-batch', async () => {
    const pool = newPool();
    expect(await pool.ensureReady()).toBe(true);
    expect(pool.isAvailable()).toBe(true);

    const files = makeFiles(40, 'midDeath');
    const batch = pool.parseFiles(files);

    // Kill one busy worker while the batch is in flight.
    await killOneBusyWorker(pool);

    const results = await batch;
    const byFile = new Set(results.map((r) => r.file));
    // Every file must come back — from the surviving workers OR the inline
    // salvage of the dead worker's chunk.
    for (const file of files) {
      expect(byFile.has(file.file), `missing ${file.file}`).toBe(true);
    }
    // Salvaged files carry real parsed symbols, not empty placeholders.
    const totalSymbols = results.reduce((n, r) => n + r.symbols.length, 0);
    expect(totalSymbols).toBeGreaterThanOrEqual(files.length * 2);
  }, 30_000);

  it('stays usable after a partial death — the next batch succeeds', async () => {
    const pool = newPool();
    expect(await pool.ensureReady()).toBe(true);

    const first = pool.parseFiles(makeFiles(40, 'first'));
    await killOneBusyWorker(pool);
    await first;

    const second = await pool.parseFiles(makeFiles(20, 'second'));
    expect(second.length).toBe(20);
  }, 30_000);

  it('rejects (never resolves empty) when every worker dies mid-batch', async () => {
    const pool = newPool();
    expect(await pool.ensureReady()).toBe(true);

    const batch = pool.parseFiles(makeFiles(40, 'fullDeath'));
    await killAllWorkers(pool);

    await expect(batch).rejects.toThrow(/all workers died mid-batch/);
    expect(pool.isAvailable()).toBe(false);
  }, 30_000);

  it('resolves a clean batch with no deaths (regression guard)', async () => {
    const pool = newPool();
    expect(await pool.ensureReady()).toBe(true);

    const results = await pool.parseFiles(makeFiles(30, 'clean'));
    expect(results.length).toBe(30);
    const totalSymbols = results.reduce((n, r) => n + r.symbols.length, 0);
    expect(totalSymbols).toBeGreaterThanOrEqual(30 * 2);
  }, 30_000);

  // `unref()` ran BEFORE `on('message')`, which re-refs a Worker, so an idle
  // pool (the never-shut-down singleton) kept the process alive forever.
  it('lets the process exit while the pool is idle and never shut down', () => {
    const result = processExitDelay('idle');
    expect(result.ready).toBe(true);
    expect(result.delay).toBeDefined();
    expect(result.delay!).toBeLessThan(1_000);
  }, 20_000);

  // shutdown's 2 s grace timer was never cleared, so the process lingered
  // 2 s after shutdown had already resolved.
  it('lets the process exit as soon as shutdown() has resolved', () => {
    const result = processExitDelay('shutdown');
    expect(result.ready).toBe(true);
    expect(result.delay).toBeDefined();
    expect(result.delay!).toBeLessThan(1_000);
  }, 20_000);
});
