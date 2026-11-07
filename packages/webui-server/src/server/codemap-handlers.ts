/**
 * CodeMap HTTP handlers — serve the dependency graph at three drill-down
 * levels (package → file → symbol) from the codebase index SQLite store.
 *
 * Each handler queries via the graph services and returns JSON. Results are
 * cached in-process and invalidated when `index.db` mtime/size changes.
 *
 * Endpoints:
 *   GET /api/codemap/packages                       — package-level graph
 *   GET /api/codemap/files?package=<name>           — file-level graph for one package
 *   GET /api/codemap/symbols?file=<path>            — symbol-level graph for one file
 */
import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import type { CodeMapGraph } from '@wrongstack/tools';
import {
  fileGraphService,
  getIndexState,
  packageGraphService,
  runStartupIndex,
  symbolGraphService,
} from '@wrongstack/tools';
import {
  clearCodemapGraphCache,
  codemapCacheKey,
  getCachedCodemapBody,
  indexDbVersion,
  setCachedCodemapBody,
} from './codemap-cache.js';
import { errMessage } from './ws-utils.js';

/** The 503 error text while a full index refresh runs; the Code Atlas surface matches it. */
export const CODEMAP_REFRESHING = 'CodeMap index refresh in progress';
/** The 503 error text while the WrongIndex service owns the index this engine would read. */
export const CODEMAP_OWNED_EXTERNALLY = 'CodeMap index is owned by the WrongIndex service';

interface CodemapHandlerDeps {
  projectRoot: string;
  /** Optional index directory override (tests, custom wiring). */
  indexDir?: string | undefined;
}
const indexJobs = new Map<
  string,
  {
    status: 'indexing' | 'ready' | 'error';
    startedAt: number;
    finishedAt?: number;
    result?: unknown;
    error?: string;
  }
>();
/** Explicit project indexing is independent of conversations and provider availability. */
export function handleCodemapIndex(
  res: http.ServerResponse,
  deps: CodemapHandlerDeps,
  start: boolean,
): void {
  if (start && indexJobs.get(deps.projectRoot)?.status !== 'indexing') {
    const job: NonNullable<ReturnType<typeof indexJobs.get>> = {
      status: 'indexing',
      startedAt: Date.now(),
    };
    indexJobs.set(deps.projectRoot, job);
    void runStartupIndex({
      projectRoot: deps.projectRoot,
      indexDir: deps.indexDir,
      timeoutMs: 120000,
    })
      .then((result) => {
        job.status = 'ready';
        job.finishedAt = Date.now();
        job.result = result;
        clearCodemapGraphCache();
      })
      .catch((error: unknown) => {
        job.status = 'error';
        job.finishedAt = Date.now();
        job.error = sanitizeApiError(error);
      });
  }
  res.writeHead(start ? 202 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...indexJobs.get(deps.projectRoot), progress: getIndexState() }));
}

function sendJsonBody(
  res: http.ServerResponse,
  status: number,
  body: string,
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS',
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Codemap-Cache': cacheStatus,
  });
  res.end(body);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS' = 'BYPASS',
): void {
  sendJsonBody(res, status, JSON.stringify(data), cacheStatus);
}

async function serveCachedGraph(
  res: http.ServerResponse,
  deps: CodemapHandlerDeps,
  scope: string,
  compute: () => Promise<CodeMapGraph>,
): Promise<void> {
  try {
    const version = await indexDbVersion(deps.projectRoot, deps.indexDir);
    const key = codemapCacheKey(deps.projectRoot, deps.indexDir, scope);
    const hit = getCachedCodemapBody(key, version);
    if (hit !== undefined) {
      sendJsonBody(res, 200, hit, 'HIT');
      return;
    }
    const graph = await compute();
    const body = JSON.stringify(graph);
    if (version !== 'missing') {
      setCachedCodemapBody(key, version, body);
    }
    sendJsonBody(res, 200, body, 'MISS');
  } catch (err) {
    // The real detail stays server-side (WS-066: a provider error body that
    // echoed an `Authorization` header used to reach the browser verbatim).
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'codemap.request_failed',
        scope,
        message: errMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
    // A full refresh is publishing a new generation: the index exists, it is just not
    // readable yet. Saying "unavailable" sent people off to build an index they already had.
    if ((err as { name?: unknown }).name === 'IndexRefreshInProgressError') {
      sendJson(res, 503, { error: CODEMAP_REFRESHING, refreshing: true }, 'BYPASS');
      return;
    }
    // The WrongIndex service owns this project's index and `indexing.service` does not use it:
    // building another index here cannot help, so the reply names the setting instead.
    if ((err as { name?: unknown }).name === 'IndexOwnedExternallyError') {
      sendJson(res, 503, { error: CODEMAP_OWNED_EXTERNALLY, ownedExternally: true }, 'BYPASS');
      return;
    }
    // 503 when the index is not yet built (node:sqlite missing or empty DB)
    sendJson(
      res,
      503,
      { error: 'CodeMap index unavailable', detail: sanitizeApiError(err) },
      'BYPASS',
    );
  }
}

/** GET /api/codemap/packages — workspace-level package dependency graph. */
export async function handleCodemapPackages(
  res: http.ServerResponse,
  deps: CodemapHandlerDeps,
): Promise<void> {
  await serveCachedGraph(res, deps, 'packages', () =>
    packageGraphService({
      projectRoot: deps.projectRoot,
      ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
    }),
  );
}

/** GET /api/codemap/files?package=<name> — file-level graph within a package. */
export async function handleCodemapFiles(
  res: http.ServerResponse,
  deps: CodemapHandlerDeps,
  pkg: string,
): Promise<void> {
  if (!pkg) {
    sendJson(res, 400, { error: 'Missing "package" query parameter' });
    return;
  }
  await serveCachedGraph(res, deps, `files:${pkg}`, () =>
    fileGraphService({
      projectRoot: deps.projectRoot,
      packageFilter: pkg,
      ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
    }),
  );
}

/** GET /api/codemap/symbols?file=<path> — symbol-level graph within a file. */
export async function handleCodemapSymbols(
  res: http.ServerResponse,
  deps: CodemapHandlerDeps,
  file: string,
): Promise<void> {
  if (!file) {
    sendJson(res, 400, { error: 'Missing "file" query parameter' });
    return;
  }
  await serveCachedGraph(res, deps, `symbols:${file}`, () =>
    symbolGraphService({
      projectRoot: deps.projectRoot,
      fileFilter: file,
      ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
    }),
  );
}
