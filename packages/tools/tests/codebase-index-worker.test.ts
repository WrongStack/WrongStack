/**
 * Integration test for the detached per-project index server.
 *
 * Source-tree runs (everything else in this suite) exercise the inline
 * fallback; this file loads the BUILT package from dist, where the host
 * resolves `project-server.js` next to the bundle and routes every operation
 * through the shared project process — the production configuration. Skipped when dist hasn't
 * been built yet (fresh checkout before `pnpm run build`).
 */

import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const distEntry = path.join(distDir, 'codebase-index', 'index.js');
const distServer = path.join(distDir, 'codebase-index', 'project-server.js');
// The worker resolves @wrongstack/core from ITS dist at runtime, so a missing
// core build (fresh checkout, or a concurrent package build wiping dist
// mid-suite) must skip rather than fail.
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const distReady =
  fsSync.existsSync(distEntry) && fsSync.existsSync(distServer) && fsSync.existsSync(coreDist);
const execFileAsync = promisify(execFile);

/**
 * Run a read query that may land while the server is publishing a generation.
 *
 * The project server refuses reads for the duration of a refresh
 * (`IndexRefreshInProgressError`, see `project-server.ts` `cachedRead`), which
 * is exactly the window a poll loop waiting on that refresh keeps hitting.
 * Production callers absorb it the same way — `codebaseSearchTool` reports it
 * as `indexStatus` instead of throwing — so a poll loop must treat it as
 * "not ready yet", not as a failure. Any other error still propagates.
 */
async function settleIndexRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((error as { name?: string }).name === 'IndexRefreshInProgressError') return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `cond` until it holds or the budget is spent. Returns its final value. */
async function until(
  cond: () => boolean | Promise<boolean>,
  budgetMs = 30_000,
  stepMs = 15,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return cond();
}

interface DistIndexApi {
  getIndexState(): {
    server: {
      status:
        | 'unavailable'
        | 'offline'
        | 'connecting'
        | 'connected'
        | 'degraded'
        | 'unresponsive'
        | 'error'
        | 'stopping';
      connected: boolean;
      pid?: number;
      activity?: { indexing: boolean };
    };
  };
  onIndexStateChange(
    listener: (state: ReturnType<DistIndexApi['getIndexState']>) => void,
  ): () => void;
  checkCodebaseIndexServerHealth(
    projectRoot: string,
    indexDir?: string,
  ): Promise<{
    status: string;
    latencyMs: number | null;
    missedHeartbeats: number;
    server?: {
      uptimeMs: number;
      memory: { rss: number; heapUsed: number };
      clients: number;
      queuedWrites: number;
      watchingExternal: boolean;
      watchingClients?: number;
    };
  }>;
  runStartupIndex(opts: {
    projectRoot: string;
    indexDir?: string;
    force?: boolean;
    timeoutMs?: number;
  }): Promise<{ filesIndexed: number; symbolsIndexed: number; errors: string[] }>;
  searchCodebaseIndex(args: {
    projectRoot: string;
    indexDir?: string;
    query: string;
    limit: number;
  }): Promise<{
    results: Array<{ name: string; file: string; snippet: string; score: number }>;
    total: number;
    /** True when the project server served a previous generation's cached answer mid-refresh. */
    stale?: boolean;
  }>;
  codebaseIndexStats(args: {
    projectRoot: string;
    indexDir?: string;
  }): Promise<{ totalSymbols: number }>;
  packageGraphService(args: {
    projectRoot: string;
    indexDir?: string;
  }): Promise<{ nodes: unknown[]; edges: unknown[] }>;
  fileGraphService(args: {
    projectRoot: string;
    indexDir?: string;
    packageFilter: string;
  }): Promise<{ nodes: unknown[]; edges: unknown[] }>;
  symbolGraphService(args: {
    projectRoot: string;
    indexDir?: string;
    fileFilter: string;
  }): Promise<{ nodes: unknown[]; edges: unknown[] }>;
  codebaseIndexTool: {
    execute(
      input: { force?: boolean },
      context: { projectRoot: string; cwd: string; meta: Record<string, unknown> },
      options: { signal: AbortSignal },
    ): Promise<{ filesIndexed: number; errors: string[] }>;
  };
  codebaseSearchTool: {
    execute(
      input: { query: string; limit?: number },
      context: { projectRoot: string; cwd: string; meta: Record<string, unknown> },
      options: { signal: AbortSignal },
    ): Promise<{ results: Array<{ name: string }>; total: number }>;
  };
  codebaseStatsTool: {
    execute(
      input: Record<string, never>,
      context: { projectRoot: string; cwd: string; meta: Record<string, unknown> },
      options: { signal: AbortSignal },
    ): Promise<{ totalSymbols: number; statsAvailable: boolean }>;
  };
  ensureCodebaseIndexServer(options: {
    projectRoot: string;
    indexDir?: string;
    watchExternal?: boolean;
    debounceMs?: number;
  }): Promise<void>;
  shutdownCodebaseIndexHost(): Promise<void>;
  shutdownCodebaseIndexServer(
    projectRoot: string,
    indexDir?: string,
    reason?: string,
  ): Promise<{ stopped: boolean; pid?: number }>;
}

describe.skipIf(!distReady)('index host (project-server mode, built dist)', () => {
  let api: DistIndexApi | undefined;
  let activeProject: { projectRoot: string; indexDir: string } | undefined;

  afterAll(async () => {
    if (api && activeProject) {
      await api.shutdownCodebaseIndexServer(
        activeProject.projectRoot,
        activeProject.indexDir,
        'test-teardown',
      );
    }
    await api?.shutdownCodebaseIndexHost();
  });

  it('indexes, searches, graphs, and shuts down through one project server', async () => {
    api = (await import(
      /* @vite-ignore */ `file://${distEntry.replace(/\\/g, '/')}`
    )) as never as DistIndexApi;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worker-'));
    const indexDir = path.join(tmpDir, '.codebase-index');
    const observedServerStates: string[] = [];
    const observedActivityStates: boolean[] = [];
    const offState = api.onIndexStateChange((state) => {
      observedServerStates.push(state.server.status);
      if (state.server.activity) observedActivityStates.push(state.server.activity.indexing);
    });
    activeProject = { projectRoot: tmpDir, indexDir };
    try {
      await fs.writeFile(
        path.join(tmpDir, 'service.ts'),
        'export class PaymentService { processRefund(): void {} }',
      );

      const result = await api.runStartupIndex({
        projectRoot: tmpDir,
        indexDir,
        timeoutMs: 60_000,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(1);
      expect(result.symbolsIndexed).toBeGreaterThanOrEqual(1);

      // camelCase-split FTS match ("refund" → processRefund), ranked + snippeted.
      const found = await api.searchCodebaseIndex({
        projectRoot: tmpDir,
        indexDir,
        query: 'refund',
        limit: 10,
      });
      expect(found.results.some((r) => r.name === 'processRefund')).toBe(true);
      expect(found.results[0]?.score).toBeGreaterThan(0);

      const stats = await api.codebaseIndexStats({ projectRoot: tmpDir, indexDir });
      expect(stats.totalSymbols).toBeGreaterThanOrEqual(1);

      const graph = await api.packageGraphService({ projectRoot: tmpDir, indexDir });
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(Array.isArray(graph.edges)).toBe(true);
      const fileGraph = await api.fileGraphService({
        projectRoot: tmpDir,
        indexDir,
        packageFilter: '(root)',
      });
      expect(Array.isArray(fileGraph.nodes)).toBe(true);
      expect(Array.isArray(fileGraph.edges)).toBe(true);
      const symbolGraph = await api.symbolGraphService({
        projectRoot: tmpDir,
        indexDir,
        fileFilter:
          found.results.find((item) => item.name === 'processRefund')?.file ?? 'service.ts',
      });
      expect(symbolGraph.nodes.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(symbolGraph.edges)).toBe(true);

      // Exercise the exact Tool objects registered for model tool-calling,
      // not only their lower-level service functions.
      const toolContext = {
        projectRoot: tmpDir,
        cwd: tmpDir,
        meta: { codebaseIndexDir: indexDir },
      };
      const toolOptions = { signal: new AbortController().signal };
      const toolSearch = await api.codebaseSearchTool.execute(
        { query: 'refund', limit: 10 },
        toolContext,
        toolOptions,
      );
      expect(toolSearch.results.some((item) => item.name === 'processRefund')).toBe(true);
      const toolStats = await api.codebaseStatsTool.execute({}, toolContext, toolOptions);
      expect(toolStats.statsAvailable).toBe(true);
      expect(toolStats.totalSymbols).toBeGreaterThanOrEqual(1);
      const toolIndex = await api.codebaseIndexTool.execute({}, toolContext, toolOptions);
      expect(toolIndex.errors).toHaveLength(0);

      await api.ensureCodebaseIndexServer({
        projectRoot: tmpDir,
        indexDir,
        watchExternal: true,
        debounceMs: 20,
      });
      const health = await api.checkCodebaseIndexServerHealth(tmpDir, indexDir);
      expect(health).toMatchObject({
        status: 'healthy',
        missedHeartbeats: 0,
        server: {
          clients: expect.any(Number),
          queuedWrites: expect.any(Number),
          watchingExternal: true,
        },
      });
      expect(health.server?.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(health.server?.memory.rss).toBeGreaterThan(0);
      expect(health.server?.memory.heapUsed).toBeGreaterThan(0);
      await fs.writeFile(
        path.join(tmpDir, 'watched.ts'),
        'export function watchedSentinel(): number { return 1; }',
      );
      let watchedFound = false;
      for (let i = 0; i < 100 && !watchedFound; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const watched = await settleIndexRead(() =>
          api!.searchCodebaseIndex({
            projectRoot: tmpDir,
            indexDir,
            query: 'watched sentinel',
            limit: 10,
          }),
        );
        watchedFound =
          watched?.results.some((result) => result.name === 'watchedSentinel') ?? false;
      }
      expect(watchedFound).toBe(true);

      // A query-only client must not disable another client's watcher.
      const observerScript = `
        const api = await import(${JSON.stringify(pathToFileURL(distEntry).href)});
        await api.ensureCodebaseIndexServer(${JSON.stringify({
          projectRoot: tmpDir,
          indexDir,
          watchExternal: false,
          debounceMs: 500,
        })});
        const health = await api.checkCodebaseIndexServerHealth(
          ${JSON.stringify(tmpDir)},
          ${JSON.stringify(indexDir)},
        );
        await api.shutdownCodebaseIndexHost();
        process.stdout.write(JSON.stringify(health));
      `;
      const observer = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', observerScript],
        { timeout: 30_000, windowsHide: true },
      );
      expect(
        JSON.parse(observer.stdout) as { server: { watchingExternal: boolean } },
      ).toMatchObject({
        server: { watchingExternal: true },
      });

      // Releasing the last owner must close the watcher and its pending queues.
      await api.ensureCodebaseIndexServer({
        projectRoot: tmpDir,
        indexDir,
        watchExternal: false,
        debounceMs: 20,
      });
      await expect(api.checkCodebaseIndexServerHealth(tmpDir, indexDir)).resolves.toMatchObject({
        server: { watchingExternal: false, watchingClients: 0 },
      });

      // Ownership also disappears when the owning client process disconnects.
      const ownerScript = `
        const api = await import(${JSON.stringify(pathToFileURL(distEntry).href)});
        await api.ensureCodebaseIndexServer(${JSON.stringify({
          projectRoot: tmpDir,
          indexDir,
          watchExternal: true,
          debounceMs: 20,
        })});
        const health = await api.checkCodebaseIndexServerHealth(
          ${JSON.stringify(tmpDir)},
          ${JSON.stringify(indexDir)},
        );
        await api.shutdownCodebaseIndexHost();
        process.stdout.write(JSON.stringify(health));
      `;
      const owner = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', ownerScript],
        { timeout: 30_000, windowsHide: true },
      );
      expect(JSON.parse(owner.stdout) as { server: { watchingExternal: boolean } }).toMatchObject({
        server: { watchingExternal: true },
      });
      let watcherReleased = false;
      for (let i = 0; i < 50 && !watcherReleased; i++) {
        const watcherHealth = await api.checkCodebaseIndexServerHealth(tmpDir, indexDir);
        watcherReleased =
          watcherHealth.server?.watchingExternal === false &&
          watcherHealth.server.watchingClients === 0;
        if (!watcherReleased) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(watcherReleased).toBe(true);

      const metadata = JSON.parse(
        await fs.readFile(path.join(indexDir, 'server.json'), 'utf8'),
      ) as { pid: number; projectRoot: string; indexDir: string };
      expect(metadata.pid).toBeGreaterThan(0);
      expect(path.resolve(metadata.projectRoot)).toBe(path.resolve(tmpDir));
      expect(path.resolve(metadata.indexDir)).toBe(path.resolve(indexDir));
      expect(api.getIndexState().server).toMatchObject({
        status: 'connected',
        connected: true,
        pid: metadata.pid,
      });
      expect(observedServerStates).toContain('connecting');
      expect(observedServerStates).toContain('connected');

      // A second OS process must connect to the existing project server rather
      // than creating another parser/SQLite owner.
      const childScript = `
        const api = await import(${JSON.stringify(pathToFileURL(distEntry).href)});
        const result = await api.runStartupIndex(${JSON.stringify({
          projectRoot: tmpDir,
          indexDir,
          force: true,
        })});
        await api.shutdownCodebaseIndexHost();
        process.stdout.write(JSON.stringify(result));
      `;
      const child = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', childScript],
        { timeout: 30_000, windowsHide: true },
      );
      expect(JSON.parse(child.stdout) as { symbolsIndexed: number }).toMatchObject({
        symbolsIndexed: expect.any(Number),
      });
      for (
        let i = 0;
        i < 50 &&
        !(observedActivityStates.includes(true) && observedActivityStates.at(-1) === false);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedActivityStates).toContain(true);
      expect(observedActivityStates.at(-1)).toBe(false);
      const afterChild = JSON.parse(
        await fs.readFile(path.join(indexDir, 'server.json'), 'utf8'),
      ) as { pid: number };
      expect(afterChild.pid).toBe(metadata.pid);

      // Disconnecting this host must not kill the shared project server.
      await api.shutdownCodebaseIndexHost();
      expect(fsSync.existsSync(path.join(indexDir, 'server.json'))).toBe(true);
      expect(api.getIndexState().server).toMatchObject({
        status: 'offline',
        connected: false,
      });
      expect(observedServerStates).toContain('offline');

      // The next operation reconnects this host to the same detached server.
      await api.codebaseIndexStats({ projectRoot: tmpDir, indexDir });
      expect(api.getIndexState().server).toMatchObject({
        status: 'connected',
        connected: true,
        pid: metadata.pid,
      });

      const stopped = await api.shutdownCodebaseIndexServer(tmpDir, indexDir, 'integration-test');
      expect(stopped).toMatchObject({ stopped: true, pid: metadata.pid });
      expect(api.getIndexState().server).toMatchObject({
        status: 'offline',
        connected: false,
      });
      for (let i = 0; i < 50 && fsSync.existsSync(path.join(indexDir, 'server.json')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fsSync.existsSync(path.join(indexDir, 'server.json'))).toBe(false);
      for (let i = 0; i < 50 && processExists(metadata.pid); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(processExists(metadata.pid)).toBe(false);

      // The next operation after a stopped server elects a fresh process and
      // reuses the persisted index without manual recovery.
      const restartedStats = await api.codebaseIndexStats({ projectRoot: tmpDir, indexDir });
      expect(restartedStats.totalSymbols).toBeGreaterThanOrEqual(1);
      const restartedMetadata = JSON.parse(
        await fs.readFile(path.join(indexDir, 'server.json'), 'utf8'),
      ) as { pid: number };
      expect(restartedMetadata.pid).not.toBe(metadata.pid);
      expect(processExists(restartedMetadata.pid)).toBe(true);
      const restartedStop = await api.shutdownCodebaseIndexServer(
        tmpDir,
        indexDir,
        'integration-restart-test',
      );
      expect(restartedStop).toMatchObject({ stopped: true, pid: restartedMetadata.pid });
      for (let i = 0; i < 50 && processExists(restartedMetadata.pid); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(processExists(restartedMetadata.pid)).toBe(false);
      activeProject = undefined;
    } finally {
      offState();
      await api.shutdownCodebaseIndexHost();
      if (activeProject) {
        await api.shutdownCodebaseIndexServer(tmpDir, indexDir, 'integration-finally');
        activeProject = undefined;
      }
      // Windows releases the server process's SQLite handles (`index.db`,
      // `-wal`, `-shm`) asynchronously after it exits, so a bare rm races the
      // OS and throws EBUSY roughly half the time even though every assertion
      // above already proved the process is gone. Node's rm retries on
      // EBUSY/EPERM/ENOTEMPTY when `maxRetries` is set.
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 90_000);

  it('serves stale cached answers over real IPC while a refresh publishes', async () => {
    const staleApi = (await import(
      /* @vite-ignore */ `file://${distEntry.replace(/\\/g, '/')}`
    )) as DistIndexApi;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-stale-'));
    const indexDir = path.join(tmpDir, '.codebase-index');
    const primeQuery = { projectRoot: tmpDir, indexDir, query: 'alphaMethod', limit: 5 };
    const uncachedQuery = { projectRoot: tmpDir, indexDir, query: 'zetaNeverPrimed', limit: 5 };
    const search = (args: typeof primeQuery) =>
      settleIndexRead(() => staleApi.searchCodebaseIndex(args));

    try {
      await fs.writeFile(
        path.join(tmpDir, 'alpha.ts'),
        'export class AlphaService { alphaMethod(): void {} }',
      );
      // A filler corpus large enough that a force rebuild holds the refresh
      // window open for many polling iterations.
      await Promise.all(
        Array.from({ length: 260 }, (_, i) =>
          fs.writeFile(path.join(tmpDir, `filler-${i}.ts`), `export const filler${i} = ${i};\n`),
        ),
      );

      const first = await staleApi.runStartupIndex({
        projectRoot: tmpDir,
        indexDir,
        timeoutMs: 120_000,
      });
      expect(first.errors).toHaveLength(0);

      // Prime the query cache at the current generation (fresh, not stale).
      const primed = await search(primeQuery);
      expect(primed?.stale).toBeUndefined();
      expect(primed?.results.some((r) => r.name === 'alphaMethod')).toBe(true);

      // Force rebuild = whole-index scope: caches clear on completion. During
      // the window the primed query must be served flagged `stale`, and a
      // never-primed query must be refused (IndexRefreshInProgressError →
      // settleIndexRead yields undefined).
      let rebuildDone = false;
      let sawStaleHit = false;
      let sawUncachedRefusal = false;
      const rebuild = staleApi
        .runStartupIndex({ projectRoot: tmpDir, indexDir, force: true, timeoutMs: 120_000 })
        .finally(() => {
          rebuildDone = true;
        });
      while (!rebuildDone) {
        if (staleApi.getIndexState().server.activity?.indexing) {
          const hit = await search(primeQuery);
          if (hit?.stale === true && hit.results.some((r) => r.name === 'alphaMethod')) {
            sawStaleHit = true;
          }
          if ((await search(uncachedQuery)) === undefined) sawUncachedRefusal = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await rebuild;
      expect(sawStaleHit).toBe(true);
      expect(sawUncachedRefusal).toBe(true);

      // Completion of the forced run cleared the caches: the next read is
      // fresh (recomputed), never stale-flagged.
      const fresh = await search(primeQuery);
      expect(fresh?.stale).toBeUndefined();
      expect(fresh?.results.some((r) => r.name === 'alphaMethod')).toBe(true);

      // Targeted (watcher) runs preserve the caches: prime again at
      // generation G, run a targeted reindex (generation G+1, caches kept),
      // then prove the primed entry survives as the stale answer inside the
      // NEXT force rebuild's window.
      await staleApi.ensureCodebaseIndexServer({
        projectRoot: tmpDir,
        indexDir,
        watchExternal: true,
        debounceMs: 20,
      });
      await fs.writeFile(
        path.join(tmpDir, 'targeted.ts'),
        'export function targetedSentinel(): void {}\n',
      );
      const targetedFound = await until(async () => {
        const hit = await search({
          projectRoot: tmpDir,
          indexDir,
          query: 'targeted sentinel',
          limit: 5,
        });
        return hit?.results.some((r) => r.name === 'targetedSentinel') ?? false;
      });
      expect(targetedFound).toBe(true);

      let secondDone = false;
      let preservedStaleHit = false;
      const second = staleApi
        .runStartupIndex({ projectRoot: tmpDir, indexDir, force: true, timeoutMs: 120_000 })
        .finally(() => {
          secondDone = true;
        });
      while (!secondDone) {
        if (staleApi.getIndexState().server.activity?.indexing) {
          if ((await search(primeQuery))?.stale === true) preservedStaleHit = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await second;
      expect(preservedStaleHit).toBe(true);
    } finally {
      await staleApi
        .shutdownCodebaseIndexServer(tmpDir, indexDir, 'stale-test-teardown')
        .catch(() => {});
      await staleApi.shutdownCodebaseIndexHost();
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
