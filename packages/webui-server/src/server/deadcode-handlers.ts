/**
 * Dead-Code Scan HTTP handlers.
 *
 * POST /api/deadcode/scan — runs `runDeadCodeScan` from @wrongstack/tools
 *   and returns structured results (deadSymbols, deadFiles, deadPackages).
 *
 * POST /api/deadcode/action-plan — converts scan results into an ordered
 *   action plan with priority-sorted file groups for LLM execution.
 */
import * as path from 'node:path';
import type * as http from 'node:http';
// Import from the subpath barrel so consuming packages resolve against
// the already-built dist/codebase-index/index.js without rebuilding @wrongstack/tools.
import { runDeadCodeScan } from '@wrongstack/tools/codebase-index';
import type { DeadCodeScanOutput } from '@wrongstack/tools/codebase-index';

interface DeadCodeHandlerDeps {
  projectRoot: string;
  indexDir?: string | undefined;
}

// ─── POST /api/deadcode/scan ───────────────────────────────────────────────

interface ScanRequestBody {
  indexDir?: string | undefined;
  entryPoints?: string[] | undefined;
}

/** Max accepted POST body size (10 MiB). Beyond this the connection is destroyed. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('Request body too large'));
        reject(new Error('Request body exceeds 10 MiB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

export async function handleDeadCodeScan(
  res: http.ServerResponse,
  deps: DeadCodeHandlerDeps,
  req: http.IncomingMessage,
): Promise<void> {
  try {
    let body: ScanRequestBody = {};
    const raw = await readJsonBody(req);
    if (raw) {
      try {
        body = JSON.parse(raw) as ScanRequestBody;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }

    // Validate client-supplied indexDir resolves inside the project root
    // to prevent path-traversal through the request body.
    const scanIndexDir = body.indexDir ?? deps.indexDir;
    if (scanIndexDir) {
      const resolvedRoot = path.resolve(deps.projectRoot);
      const resolvedIndex = path.resolve(deps.projectRoot, scanIndexDir);
      if (resolvedIndex !== resolvedRoot && !resolvedIndex.startsWith(resolvedRoot + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid indexDir: must be within project root' }));
        return;
      }
    }

    const result = runDeadCodeScan(deps.projectRoot, {
      indexDir: scanIndexDir,
      userEntryPoints: body.entryPoints,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Dead-code scan failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// ─── POST /api/deadcode/action-plan ────────────────────────────────────────

interface ActionPlanFile {
  file: string;
  symbolCount: number;
  /** The kind of symbols to remove (for the LLM prompt). */
  symbols: string[];
  /** Suggested priority: 0 = dead package (highest impact), 1 = dead file, 2 = dead symbol. */
  priority: number;
}

interface ActionPlan {
  summary: string;
  files: ActionPlanFile[];
  totalDeadSymbols: number;
  totalDeadFiles: number;
  totalDeadPackages: number;
}

export function handleDeadCodeActionPlan(
  res: http.ServerResponse,
  _deps: DeadCodeHandlerDeps,
  req: http.IncomingMessage,
): Promise<void> {
  return readJsonBody(req)
    .then((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid scan result JSON' }));
        return;
      }

      // Runtime shape check: buildActionPlan accesses deadPackages, deadFiles,
      // deadSymbols, and stats.dead — verify they exist before trusting the cast.
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Array.isArray((parsed as Record<string, unknown>).deadPackages) ||
        !Array.isArray((parsed as Record<string, unknown>).deadFiles) ||
        !Array.isArray((parsed as Record<string, unknown>).deadSymbols)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'Invalid scan result: missing or malformed required fields ' +
              '(deadPackages, deadFiles, deadSymbols)',
          }),
        );
        return;
      }

      const result = parsed as DeadCodeScanOutput;
      const plan = buildActionPlan(result);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan));
    })
    .catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Failed to read request body',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    });
}

function buildActionPlan(result: DeadCodeScanOutput): ActionPlan {
  const files = new Map<string, ActionPlanFile>();

  // P0: Dead packages — all files in the package.
  for (const dp of result.deadPackages) {
    // The scan returns deadPackage objects; synthesize file entries.
    const pseudoFile: ActionPlanFile = {
      file: `${dp.package}/ (package)`,
      symbolCount: dp.fileCount,
      symbols: [`remove package ${dp.package} (${dp.fileCount} files, path: ${dp.path})`],
      priority: 0,
    };
    files.set(pseudoFile.file, pseudoFile);
  }

  // P1: Dead files — all symbols are unreferenced.
  for (const df of result.deadFiles) {
    const existing = files.get(df.file);
    if (existing) {
      // Already queued as part of a dead package — keep the higher priority.
      if (existing.priority > 1) existing.priority = 1;
      existing.symbolCount += df.symbolCount;
      continue;
    }
    files.set(df.file, {
      file: df.file,
      symbolCount: df.symbolCount,
      symbols: [`entire file (${df.symbolCount} symbols) is dead`],
      priority: 1,
    });
  }

  // P2: Individual dead symbols in otherwise-alive files.
  const deadInAliveFiles = new Map<string, string[]>();
  const deadFileSet = new Set(result.deadFiles.map((df) => df.file));
  for (const ds of result.deadSymbols) {
    if (deadFileSet.has(ds.file)) continue; // already counted in deadFiles
    const list = deadInAliveFiles.get(ds.file) ?? [];
    list.push(`${ds.kind} ${ds.name} (line ${ds.line})`);
    deadInAliveFiles.set(ds.file, list);
  }
  for (const [file, symbols] of deadInAliveFiles) {
    const existing = files.get(file);
    if (existing) {
      existing.symbols.push(...symbols);
      existing.symbolCount += symbols.length;
      continue;
    }
    files.set(file, {
      file,
      symbolCount: symbols.length,
      symbols,
      priority: 2,
    });
  }

  const sorted = [...files.values()].sort(
    (a, b) => a.priority - b.priority || a.file.localeCompare(b.file),
  );

  return {
    summary:
      `Dead-code scan found ${result.stats.dead} dead symbols across ` +
      `${result.deadFiles.length} dead files and ${result.deadPackages.length} dead packages. ` +
      `Action plan has ${sorted.length} file group(s) to address.`,
    files: sorted,
    totalDeadSymbols: result.stats.dead,
    totalDeadFiles: result.deadFiles.length,
    totalDeadPackages: result.deadPackages.length,
  };
}
