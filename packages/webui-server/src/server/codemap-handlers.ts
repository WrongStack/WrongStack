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
import type { CodeMapGraph } from '@wrongstack/tools';
import { fileGraphService, packageGraphService, symbolGraphService } from '@wrongstack/tools';
import {
  codemapCacheKey,
  getCachedCodemapBody,
  indexDbVersion,
  setCachedCodemapBody,
} from './codemap-cache.js';

interface CodemapHandlerDeps {
  projectRoot: string;
  /** Optional index directory override (tests, custom wiring). */
  indexDir?: string | undefined;
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
    const msg = err instanceof Error ? err.message : String(err);
    // 503 when the index is not yet built (node:sqlite missing or empty DB)
    sendJson(res, 503, { error: 'CodeMap index unavailable', detail: msg }, 'BYPASS');
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
