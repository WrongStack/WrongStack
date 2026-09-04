import type * as http from 'node:http';
import * as v8 from 'node:v8';
import { sanitizeApiError } from '@wrongstack/core/security';
import { getIndexState } from '@wrongstack/tools';
import {
  handleCodemapFiles,
  handleCodemapPackages,
  handleCodemapSymbols,
} from '../codemap-handlers.js';
import { handleDeadCodeActionPlan, handleDeadCodeScan } from '../deadcode-handlers.js';
import { readRecentProcessMemoryDiagnostics } from '../memory-diagnostics.js';
import {
  handleRequirementIntakeAnswers,
  handleRequirementIntakeArchive,
  handleRequirementIntakeCancel,
  handleRequirementIntakeCreate,
  handleRequirementIntakeGet,
  handleRequirementIntakeList,
  handleRequirementIntakeListForServer,
  handleRequirementIntakeSubmit,
  handleRequirementIntakeSuggestions,
  handleRequirementIntakeUpdate,
} from '../requirement-intake-handlers.js';
import {
  handleTechStackAnalyze,
  handleTechStackCancel,
  handleTechStackDependencyResearch,
  handleTechStackInventory,
  handleTechStackJobStatus,
  handleTechStackRemediationApply,
  handleTechStackRemediationPlan,
  handleTechStackReport,
  handleTechStackSnapshot,
  handleTechStackTrends,
  type TechStackEvent,
} from '../techstack-handlers.js';
import {
  handleApiAnalyticsGet,
  handleApiAnalyticsPost,
  handleApiAnalyticsSummary,
} from './analytics-handler.js';
import {
  handleApiFleetBroadcast,
  handleApiSessionAgents,
  handleApiSessionEvents,
  handleApiSessionInterrupt,
  handleApiSessionMailbox,
  handleApiSessionMessage,
  handleApiSessions,
} from './api-handlers.js';
import { decodeSessionId, strictDecodeParam } from './security-helpers.js';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import {
  handleMemorySearch,
  handleVectorMemoryForget,
  handleVectorMemorySearch,
  handleVectorMemoryStatus,
  handleVectorMemoryStore,
} from './vector-memory-handlers.js';

export interface ApiRouterDeps {
  globalRoot?: string | undefined;
  projectRoot?: string | undefined;
  indexDir?: string | undefined;
  intakeService?: import('@wrongstack/requirement-intake').RequirementIntakeService | undefined;
  onFleetPing?: (() => void) | undefined;
  watcherMetrics?: import('../setup-events.js').FileWatcherMetrics | undefined;
  onTechStackEvent?: ((event: TechStackEvent) => void) | undefined;
  getLlm?:
    | (() => { provider: import('@wrongstack/core/types').Provider; model: string } | undefined)
    | undefined;
  executePackageOperation?: import('../techstack-handlers.js').TechStackHandlerDeps['executePackageOperation'];
  /**
   * Optional vector memory store. When provided, the four
   * `GET /api/vector-memory/status|search` and `POST /api/vector-memory/store`
   * / `DELETE /api/vector-memory/store/:id` routes become active.
   * Defaults to undefined so non-CLI webui-server hosts (e.g. a headless
   * fleet dashboard) are unaffected.
   */
  getVectorMemoryStore?: (() => VectorMemoryStore | undefined) | undefined;
  /** Model cache directory for the vector memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
  /**
   * Optional SAGE memory store. When provided, the
   * `GET /api/memory/search?q=…&explain=1` route becomes active. Same
   * strict opt-in contract as the vector memory store — non-CLI hosts
   * that don't wire a memory store stay on their existing surface.
   */
  getMemoryStore?: (() => import('@wrongstack/core/types').MemoryPort | undefined) | undefined;
}

export async function handleApiRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ApiRouterDeps,
  requireAccessToken: boolean,
  accessTokenOk: boolean,
  getTechStackRuntime: () => Promise<{
    store: import('@wrongstack/techstack').TechStackStore;
    engine: import('@wrongstack/techstack').TechStackEngine;
    runningJobs: Map<string, AbortController>;
  }>,
): Promise<boolean> {
  if (url.pathname === '/api/fleet/ping' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    try {
      deps.onFleetPing?.();
    } catch {
      /* best-effort */
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiSessions(res, deps.globalRoot);
    return true;
  }

  const agentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/agents$/);
  if (agentsMatch && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiSessionAgents(res, deps.globalRoot, decodeSessionId(agentsMatch[1]!));
    return true;
  }

  const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
    await handleApiSessionEvents(res, deps.globalRoot, decodeSessionId(eventsMatch[1]!), limit);
    return true;
  }

  const msgMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (msgMatch && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiSessionMessage(res, req, deps.globalRoot, decodeSessionId(msgMatch[1]!));
    return true;
  }

  const mailboxMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mailbox$/);
  if (mailboxMatch && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiSessionMailbox(res, deps.globalRoot, decodeSessionId(mailboxMatch[1]!));
    return true;
  }

  const interruptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiSessionInterrupt(res, req, deps.globalRoot, decodeSessionId(interruptMatch[1]!));
    return true;
  }

  if (url.pathname === '/api/fleet/broadcast' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiFleetBroadcast(res, req, deps.globalRoot);
    return true;
  }

  if (url.pathname === '/api/analytics' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiAnalyticsPost(res, req);
    return true;
  }
  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiAnalyticsGet(res, url);
    return true;
  }
  if (url.pathname === '/api/analytics/summary' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleApiAnalyticsSummary(res);
    return true;
  }

  if (url.pathname === '/api/requirement-intakes' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleRequirementIntakeListForServer(res, deps.intakeService, deps.projectRoot);
    return true;
  }

  const intakeProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirement-intakes$/);
  if (intakeProjectMatch && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleRequirementIntakeCreate(
      res,
      req,
      deps.intakeService,
      decodeURIComponent(intakeProjectMatch[1]!),
    );
    return true;
  }
  if (intakeProjectMatch && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleRequirementIntakeList(
      res,
      deps.intakeService,
      decodeURIComponent(intakeProjectMatch[1]!),
    );
    return true;
  }

  const intakeIdMatch = url.pathname.match(/^\/api\/requirement-intakes\/([^/]+)$/);
  if (intakeIdMatch && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleRequirementIntakeGet(res, deps.intakeService, intakeIdMatch[1]!);
    return true;
  }
  if (intakeIdMatch && req.method === 'PATCH') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleRequirementIntakeUpdate(res, req, deps.intakeService, intakeIdMatch[1]!);
    return true;
  }

  const intakeActionMatch = url.pathname.match(
    /^\/api\/requirement-intakes\/([^/]+)\/(answers|suggestions|submit|cancel|archive)$/,
  );
  if (intakeActionMatch && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    const intakeId = intakeActionMatch[1]!;
    const action = intakeActionMatch[2]!;
    if (action === 'answers') {
      await handleRequirementIntakeAnswers(res, req, deps.intakeService, intakeId);
    } else if (action === 'suggestions') {
      await handleRequirementIntakeSuggestions(res, req, deps.intakeService, intakeId);
    } else if (action === 'submit') {
      await handleRequirementIntakeSubmit(res, deps.intakeService, intakeId);
    } else if (action === 'cancel') {
      await handleRequirementIntakeCancel(res, req, deps.intakeService, intakeId);
    } else {
      await handleRequirementIntakeArchive(res, deps.intakeService, intakeId);
    }
    return true;
  }

  if (url.pathname === '/api/codemap/packages' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (!deps.projectRoot) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project root not configured' }));
      return true;
    }
    await handleCodemapPackages(res, {
      projectRoot: deps.projectRoot,
      ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
    });
    return true;
  }

  if (url.pathname === '/api/codemap/files' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (!deps.projectRoot) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project root not configured' }));
      return true;
    }
    const pkg = url.searchParams.get('package') ?? '';
    await handleCodemapFiles(
      res,
      {
        projectRoot: deps.projectRoot,
        ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
      },
      pkg,
    );
    return true;
  }

  if (url.pathname === '/api/codemap/symbols' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (!deps.projectRoot) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project root not configured' }));
      return true;
    }
    const file = url.searchParams.get('file') ?? '';
    await handleCodemapSymbols(
      res,
      {
        projectRoot: deps.projectRoot,
        ...(deps.indexDir ? { indexDir: deps.indexDir } : {}),
      },
      file,
    );
    return true;
  }

  if (url.pathname.startsWith('/api/techstack/')) {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (!deps.projectRoot) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project root not configured' }));
      return true;
    }
    try {
      const runtime = await getTechStackRuntime();
      const techDeps = {
        projectId: deps.projectRoot,
        projectRoot: deps.projectRoot,
        store: runtime.store,
        engine: runtime.engine,
        runningJobs: runtime.runningJobs,
        emit: deps.onTechStackEvent,
        getLlm: deps.getLlm,
        executePackageOperation: deps.executePackageOperation,
      };
      if (url.pathname === '/api/techstack/snapshot' && req.method === 'GET') {
        handleTechStackSnapshot(res, techDeps);
        return true;
      }
      if (url.pathname === '/api/techstack/inventory' && req.method === 'POST') {
        handleTechStackInventory(res, techDeps);
        return true;
      }
      if (url.pathname === '/api/techstack/analyze' && req.method === 'POST') {
        handleTechStackAnalyze(res, techDeps);
        return true;
      }
      if (url.pathname === '/api/techstack/trends' && req.method === 'GET') {
        await handleTechStackTrends(res, techDeps);
        return true;
      }
      if (url.pathname === '/api/techstack/remediation' && req.method === 'GET') {
        await handleTechStackRemediationPlan(res, techDeps);
        return true;
      }
      if (url.pathname === '/api/techstack/remediation/apply' && req.method === 'POST') {
        await handleTechStackRemediationApply(req, res, techDeps);
        return true;
      }
      const cancelMatch = /^\/api\/techstack\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelMatch && req.method === 'POST') {
        const id = strictDecodeParam(cancelMatch[1]!, res);
        if (id === null) return true;
        handleTechStackCancel(res, techDeps, id);
        return true;
      }
      const jobMatch = /^\/api\/techstack\/jobs\/([^/]+)$/.exec(url.pathname);
      if (jobMatch && req.method === 'GET') {
        const id = strictDecodeParam(jobMatch[1]!, res);
        if (id === null) return true;
        handleTechStackJobStatus(res, techDeps, id);
        return true;
      }
      const reportMatch = /^\/api\/techstack\/reports\/([^/]+)$/.exec(url.pathname);
      if (reportMatch && req.method === 'GET') {
        const id = strictDecodeParam(reportMatch[1]!, res);
        if (id === null) return true;
        const rawFmt = url.searchParams.get('format');
        const fmt =
          rawFmt === 'json' || rawFmt === 'spdx' || rawFmt === 'cyclonedx' ? rawFmt : 'md';
        handleTechStackReport(res, techDeps, id, fmt);
        return true;
      }
      const researchMatch = /^\/api\/techstack\/deps\/([^/]+)\/research$/.exec(url.pathname);
      if (researchMatch && req.method === 'POST') {
        const pkg = strictDecodeParam(researchMatch[1]!, res);
        if (pkg === null) return true;
        await handleTechStackDependencyResearch(res, techDeps, pkg);
        return true;
      }
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'TechStack store unavailable',
          detail: sanitizeApiError(error),
        }),
      );
      return true;
    }
  }

  if (url.pathname === '/debug/watcher-metrics' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (deps.watcherMetrics) {
      const avgDelay =
        deps.watcherMetrics.broadcastsSent > 0
          ? deps.watcherMetrics.totalDebounceDelayMs / deps.watcherMetrics.broadcastsSent
          : 0;
      const response = {
        ...deps.watcherMetrics,
        averageDebounceDelayMs: avgDelay,
        timestamp: Date.now(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File watcher metrics not available' }));
    }
    return true;
  }

  if (url.pathname === '/debug/system' && req.method === 'GET') {
    // The only route in this file that was missing the token gate its 29
    // neighbours carry — including `/debug/watcher-metrics` directly above.
    // `http-server.ts` rejects tokenless requests before this router is even
    // called, so the omission was never exploitable; it was an inconsistency
    // in a repeated pattern, and this response is the most sensitive body
    // here (pid, heap limits, cpu, and per-process diagnostics for up to 32
    // WrongStack processes). Completing the pattern keeps the defence intact
    // if this router is ever mounted behind a different front door.
    // See docs/audit/webui-full-review-2026-09-03.md B-12.
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    const processes = await readRecentProcessMemoryDiagnostics(deps.globalRoot);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
        heapLimit: v8.getHeapStatistics().heap_size_limit,
        uptime: process.uptime(),
        cpuUsage: process.cpuUsage(),
        codebaseIndexServer: getIndexState().server,
        processes,
        timestamp: Date.now(),
      }),
    );
    return true;
  }

  if (url.pathname === '/api/deadcode/scan' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (!deps.projectRoot) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project root not configured' }));
      return true;
    }
    await handleDeadCodeScan(
      res,
      {
        projectRoot: deps.projectRoot,
        indexDir: deps.indexDir,
      },
      req,
    );
    return true;
  }

  const vectorForgetMatch = /^\/api\/vector-memory\/store\/([^/]+)$/.exec(url.pathname);
  if (vectorForgetMatch && req.method === 'DELETE') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleVectorMemoryForget(res, url, () => deps.getVectorMemoryStore?.());
    return true;
  }

  // Vector memory — opt-in surface. The four dispatcher branches
  // (status / search / store / forget) are wired here. When no
  // `getVectorMemoryStore` dependency is provided, the handlers
  // themselves respond with `enabled: false` (status) or 503 (others),
  // so a non-CLI webui-server host stays on its existing surface with
  // zero behavior change.
  if (url.pathname === '/api/vector-memory/status' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleVectorMemoryStatus(res, () => deps.getVectorMemoryStore?.(), {
      ...(deps.projectRoot ? { projectRoot: deps.projectRoot } : {}),
      ...(deps.vectorMemoryModelCacheDir ? { modelCacheDir: deps.vectorMemoryModelCacheDir } : {}),
    });
    return true;
  }

  if (url.pathname === '/api/vector-memory/search' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleVectorMemorySearch(res, url, () => deps.getVectorMemoryStore?.());
    return true;
  }

  if (url.pathname === '/api/vector-memory/store' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleVectorMemoryStore(res, req, () => deps.getVectorMemoryStore?.());
    return true;
  }

  // SAGE memory search — opt-in, like the vector memory routes. When
  // `?explain=1` is set the response carries a per-channel score
  // breakdown (lexical / vector / RRF final / `source`); without the
  // flag the route degrades to a position-derived lexical-only score
  // and the response shape stays compatible.
  if (url.pathname === '/api/memory/search' && req.method === 'GET') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleMemorySearch(res, url, () => deps.getMemoryStore?.());
    return true;
  }

  if (url.pathname === '/api/deadcode/action-plan' && req.method === 'POST') {
    if (requireAccessToken && !accessTokenOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    await handleDeadCodeActionPlan(
      res,
      {
        projectRoot: deps.projectRoot ?? '',
        indexDir: deps.indexDir,
      },
      req,
    );
    return true;
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return true;
  }

  return false;
}
