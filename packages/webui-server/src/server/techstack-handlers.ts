/**
 * TechStack HTTP handlers.
 *
 * Endpoints:
 *   GET  /api/techstack/snapshot
 *   POST /api/techstack/inventory
 *   POST /api/techstack/analyze
 *   POST /api/techstack/jobs/:id/cancel
 *   POST /api/techstack/deps/:id/research
 *
 * Commands arrive over REST; progress goes back over the WebSocket via `emit`.
 *
 * @see docs/specs/techstack-sdd.md §4.2
 */

import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import type { Provider } from '@wrongstack/core/types';
import type {
  AnalyzeDepth,
  PackageOperation,
  Snapshot,
  TechStackEngine,
  TechStackJobKind,
  TechStackResearcher,
  TechStackStore,
} from '@wrongstack/techstack';

/** Upper bound on a single-package deep dive: one search fan-out + one LLM call. */
const DEEP_DIVE_TIMEOUT_MS = 60_000;

/** Upper bound on the JSON body for POST endpoints that accept options. */
const ANALYZE_BODY_LIMIT_BYTES = 16 * 1024;

/** Pipeline depth values accepted on the wire. */
const DEPTH_VALUES: readonly AnalyzeDepth[] = ['inventory', 'enrich', 'full'];

/**
 * Narrow, additive options the WebUI sends with `POST /api/techstack/analyze`.
 *
 * Kept local to the handler module: the engine contract (`AnalyzeOptions`)
 * already covers these, but the handler is the trust boundary that scrubs
 * untrusted JSON before it reaches the engine — the shape is what crosses the
 * wire, not the engine's internal `online` flag.
 */
export interface AnalyzeRequestOptions {
  readonly model?: string;
  readonly depth?: AnalyzeDepth;
}

function isAnalyzeDepth(value: unknown): value is AnalyzeDepth {
  return typeof value === 'string' && (DEPTH_VALUES as readonly string[]).includes(value);
}

/**
 * Read an optional JSON body carrying `AnalyzeRequestOptions`. Anything that
 * is not parseable JSON, exceeds the body limit, or contains the wrong shape
 * degrades to `{}` — the analyze endpoint is idempotent under partial options.
 *
 * Returns `{ ok: false, status?, detail? }` only for the unrecoverable cases
 * (body too large, malformed JSON). The shape decision is reported separately
 * via the helpers below so the caller can give the user a precise reason.
 */
async function readAnalyzeOptions(
  req: http.IncomingMessage,
): Promise<
  | { ok: true; options: AnalyzeRequestOptions }
  | { ok: false; status: number; error: string; detail?: string }
> {
  let raw = '';
  let oversized = false;
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(raw) > ANALYZE_BODY_LIMIT_BYTES) {
      oversized = true;
      break;
    }
  }
  if (oversized) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  if (raw.trim() === '') {
    return { ok: true, options: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, status: 400, error: 'Invalid request body', detail: errorMessage(error) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'Request body must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  let model: string | undefined;
  let depth: AnalyzeDepth | undefined;
  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string' || obj.model.length > 200) {
      return {
        ok: false,
        status: 400,
        error: '`model` must be a non-empty string up to 200 characters',
      };
    }
    model = obj.model;
  }
  if (obj.depth !== undefined) {
    if (!isAnalyzeDepth(obj.depth)) {
      return {
        ok: false,
        status: 400,
        error: `\`depth\` must be one of ${DEPTH_VALUES.join(', ')}`,
      };
    }
    depth = obj.depth;
  }
  return {
    ok: true,
    options: {
      ...(model ? { model } : {}),
      ...(depth ? { depth } : {}),
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export interface TechStackHandlerDeps {
  /** Project ID used to look up the snapshot. */
  projectId: string;
  /** Server-owned project root. Never sourced from the request body. */
  projectRoot?: string | undefined;
  /** TechStack store instance. */
  store: TechStackStore;
  /** Service engine for inventory/analyze actions. */
  engine?: TechStackEngine | undefined;
  /** Publish WS-compatible events without coupling the HTTP layer to sockets. */
  emit?: ((event: TechStackEvent) => void) | undefined;
  /** Abort controllers keyed by running job id. */
  runningJobs?: Map<string, AbortController> | undefined;
  /**
   * Live provider access for the LLM research stage. Returns `undefined` when
   * no provider is configured, which downgrades `analyze` to a purely
   * deterministic run rather than failing it.
   *
   * A getter, not a captured value: the user can switch model or rotate
   * credentials mid-session (config hot-reload), and a provider snapshotted at
   * server construction would go stale without anyone noticing.
   */
  getLlm?: (() => { provider: Provider; model: string } | undefined) | undefined;
  /** Normal permission-governed bridge to the language_package tool. */
  executePackageOperation?:
    | ((
        operation: PackageOperation,
        workspace?: string,
      ) => Promise<{ readonly detail?: string } | void>)
    | undefined;
}

/**
 * Build the research stage for a job, or `undefined` when research should not
 * run (offline inventory, or no provider wired).
 */
async function buildResearcher(
  deps: TechStackHandlerDeps,
  kind: TechStackJobKind,
): Promise<TechStackResearcher | undefined> {
  if (kind !== 'analyze' || !deps.getLlm) return undefined;
  const { createProviderLlm, createResearcher, createToolSearch } = await import(
    '@wrongstack/techstack'
  );
  const llm = createProviderLlm(deps.getLlm);
  if (!llm) return undefined;
  return createResearcher({ llm, search: createToolSearch() });
}

export type TechStackEvent =
  | {
      type: 'techstack.job.started';
      payload: {
        jobId: string;
        kind: 'inventory' | 'analyze';
        /** Pipeline depth the job will run. Optional for legacy producers. */
        depth?: 'inventory' | 'enrich' | 'full';
        /** Model id the user picked for the LLM research stage. */
        model?: string;
      };
    }
  | {
      type: 'techstack.job.progress';
      payload: { jobId: string; phase: string; completed: number; total: number };
    }
  | { type: 'techstack.snapshot.updated'; payload: { snapshot: Snapshot; stale: false } }
  | { type: 'techstack.job.failed'; payload: { jobId: string; error: string } }
  | { type: 'techstack.job.cancelled'; payload: { jobId: string } }
  | {
      type: 'techstack.research.partial';
      payload: { dependencyId: string; completed: number; total: number };
    };

/** GET /api/techstack/snapshot */
export function handleTechStackSnapshot(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): void {
  try {
    const snapshot = deps.store.getSnapshot(deps.projectId);
    if (!snapshot) {
      sendJson(res, 404, { snapshot: null, stale: false });
      return;
    }
    const ageMs = Date.now() - new Date(snapshot.createdAt).getTime();
    sendJson(res, 200, { snapshot, stale: ageMs > 24 * 60 * 60 * 1000 });
  } catch (error) {
    sendJson(res, 500, {
      error: 'TechStack store unavailable',
      detail: errorMessage(error),
    });
  }
}

/**
 * Client-facing error text.
 *
 * Every caller sends the result to the browser, so it goes through the project's
 * shared sanitizer (WS-066) rather than echoing `err.message`. The raw messages
 * here carry absolute database paths and, on the research routes, provider
 * transport errors — detail that belongs in the server log, not in a response
 * body. This helper previously returned the raw message and was the one place
 * in the file that bypassed `sanitizeApiError`.
 */
function errorMessage(error: unknown): string {
  return sanitizeApiError(error);
}

function requireJobDeps(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): deps is TechStackHandlerDeps & { projectRoot: string; engine: TechStackEngine } {
  if (!deps.projectRoot || !deps.engine) {
    sendJson(res, 503, { error: 'TechStack engine unavailable' });
    return false;
  }
  return true;
}

function startJob(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
  kind: TechStackJobKind,
  requestOptions: AnalyzeRequestOptions = {},
): void {
  if (!requireJobDeps(res, deps)) return;

  const jobId = randomUUID();
  const controller = new AbortController();
  deps.runningJobs?.set(jobId, controller);
  const resolvedDepth = requestOptions.depth ?? (kind === 'inventory' ? 'inventory' : 'full');
  deps.emit?.({
    type: 'techstack.job.started',
    payload: {
      jobId,
      kind,
      ...(requestOptions.model ? { model: requestOptions.model } : {}),
      depth: resolvedDepth,
    },
  });
  sendJson(res, 202, {
    jobId,
    kind,
    status: 'queued',
    ...(requestOptions.model ? { model: requestOptions.model } : {}),
    depth: resolvedDepth,
  });

  void buildResearcher(deps, kind)
    .catch(() => undefined)
    .then((researcher) =>
      deps.engine.analyze(deps.projectId, {
        targetRoot: deps.projectRoot,
        requestedBy: 'webui',
        // `depth` is the authoritative knob; `online` stays as a deprecated
        // alias (true ≡ full, false ≡ inventory) so the WebUI's old "offline
        // inventory" button keeps working.
        ...(requestOptions.depth
          ? { depth: requestOptions.depth }
          : { online: kind === 'analyze' }),
        ...(requestOptions.model ? { model: requestOptions.model } : {}),
        jobId,
        signal: controller.signal,
        researcher,
        onProgress: (phase, completed, total) => {
          deps.emit?.({
            type: 'techstack.job.progress',
            payload: { jobId, phase, completed, total },
          });
        },
        ...(deps.emit
          ? {
              // Per-dependency streaming partial: the engine fires once per
              // cluster (no dependencyId) and once per dependency (with
              // dependencyId) inside it. The WS layer only forwards
              // dependency-scoped partials — the cluster-level "started"
              // emit is engine-internal noise the UI does not need.
              onResearchPartial: (partial) => {
                if (!partial.dependencyId) return;
                deps.emit?.({
                  type: 'techstack.research.partial',
                  payload: {
                    dependencyId: partial.dependencyId,
                    completed: partial.completed,
                    total: partial.total,
                  },
                });
              },
            }
          : {}),
      }),
    )
    .then(({ snapshot }) => {
      if (controller.signal.aborted) return;
      deps.emit?.({
        type: 'techstack.snapshot.updated',
        payload: { snapshot, stale: false },
      });
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        deps.emit?.({ type: 'techstack.job.cancelled', payload: { jobId } });
        return;
      }
      deps.emit?.({
        type: 'techstack.job.failed',
        payload: { jobId, error: errorMessage(error) },
      });
    })
    .finally(() => {
      deps.runningJobs?.delete(jobId);
    });
}

/** POST /api/techstack/inventory */
export function handleTechStackInventory(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): void {
  startJob(res, deps, 'inventory');
}

/** POST /api/techstack/analyze */
export async function handleTechStackAnalyze(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): Promise<void> {
  const parsed = await readAnalyzeOptions(req);
  if (!parsed.ok) {
    sendJson(res, parsed.status, {
      error: parsed.error,
      ...(parsed.detail ? { detail: parsed.detail } : {}),
    });
    return;
  }
  startJob(res, deps, 'analyze', parsed.options);
}

/**
 * GET /api/techstack/models — return the providers/models that are currently
 * available to the LLM research stage. The browser uses this to populate a
 * model picker before the user clicks `Analyze`.
 *
 * `getLlm()` is a getter on purpose (r25 + r1): the user can rotate credentials
 * mid-session, and a snapshot would silently go stale. When no provider is
 * wired the endpoint still answers 200 with `{ available: false }` so the UI
 * can disable the picker without falling back to a default.
 */
export function handleTechStackModels(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): void {
  const llm = deps.getLlm?.();
  if (!llm) {
    sendJson(res, 200, { available: false, provider: null, model: null, candidates: [] });
    return;
  }
  const provider = llm.provider as Provider & {
    readonly name?: string;
    readonly models?: ReadonlyArray<{ readonly id: string }>;
    readonly capabilities?: {
      readonly structuredOutput?: boolean;
      readonly jsonMode?: boolean;
    };
  };
  const candidates =
    provider.models
      ?.map((m) => ({ id: m.id }))
      .filter((m): m is { id: string } => typeof m.id === 'string') ?? [];
  sendJson(res, 200, {
    available: true,
    provider: provider.name ?? 'unknown',
    model: llm.model,
    capabilities: {
      structuredOutput: provider.capabilities?.structuredOutput ?? false,
      jsonMode: provider.capabilities?.jsonMode ?? false,
    },
    candidates,
  });
}

/** POST /api/techstack/jobs/:id/cancel — idempotent. */
export function handleTechStackCancel(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
  jobId: string,
): void {
  const controller = deps.runningJobs?.get(jobId);
  if (controller && !controller.signal.aborted) controller.abort();
  deps.store.updateJobStatus(jobId, 'cancelled');
  deps.emit?.({ type: 'techstack.job.cancelled', payload: { jobId } });
  sendJson(res, 200, { jobId, status: 'cancelled' });
}

/**
 * POST /api/techstack/deps/:id/research — deep dive on one dependency.
 *
 * Synchronous: one package is a single cluster and a single LLM call, so the
 * caller gets the findings in the response rather than having to correlate a
 * job id over the socket.
 *
 * Deliberately bypasses triage. Triage answers "what is worth spending tokens
 * on unprompted"; an explicit click has already answered that, so a `current`
 * package the user is curious about is fair game.
 */
export async function handleTechStackDependencyResearch(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
  dependencyId: string,
): Promise<void> {
  const snapshot = deps.store.getSnapshot(deps.projectId);
  const dependency = snapshot?.dependencies.find((dep) => dep.id === dependencyId);
  if (!dependency) {
    sendJson(res, 404, { error: 'Dependency not found in the current snapshot' });
    return;
  }

  const version = dependency.locked ?? dependency.requested ?? 'latest';
  const cacheKey = `research:${dependency.ecosystem}:${dependency.name}:${version}`;
  const cached = deps.store.getCachedResearch(cacheKey);
  if (cached && cached.length > 0) {
    sendJson(res, 200, { dependencyId, findings: cached, cached: true });
    return;
  }

  let researcher: TechStackResearcher | undefined;
  try {
    researcher = await buildResearcher(deps, 'analyze');
  } catch (error) {
    sendJson(res, 503, { error: 'Research unavailable', detail: errorMessage(error) });
    return;
  }
  if (!researcher) {
    sendJson(res, 503, {
      error: 'No model configured — connect a provider to run LLM analysis.',
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('research timeout'));
  }, DEEP_DIVE_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const { triageCandidates } = await import('@wrongstack/techstack');
    // Reuse triage purely to derive the right cluster for this status; fall
    // back to a breaking-change read when the status is one triage skips.
    const [triaged] = triageCandidates([dependency], { limit: 1 });
    const findings = await researcher.research(
      [triaged ?? { dependency, cluster: 'breaking_change', priority: 0 }],
      { signal: controller.signal },
    );
    if (findings.length > 0) {
      deps.store.setCachedResearch(cacheKey, findings);
    }
    sendJson(res, 200, { dependencyId, findings, cached: false });
  } catch (error) {
    sendJson(res, 500, { error: 'Research failed', detail: errorMessage(error) });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** GET /api/techstack/jobs/:id */
export function handleTechStackJobStatus(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
  jobId: string,
): void {
  const job = deps.store.getJob(jobId);
  if (!job) {
    sendJson(res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(res, 200, { job });
}

/** GET /api/techstack/reports/:id?format=md|json|spdx|cyclonedx */
export function handleTechStackReport(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
  reportId: string,
  format: 'md' | 'json' | 'spdx' | 'cyclonedx',
): void {
  const snapshot = deps.store.getSnapshotById(reportId);
  if (!snapshot) {
    sendJson(res, 404, { error: 'Report not found' });
    return;
  }
  if (deps.engine) {
    const report = deps.engine.generateReport(snapshot, format);
    const contentType = format === 'md' ? 'text/markdown' : 'application/json';
    const filename =
      format === 'spdx'
        ? 'techstack-sbom-spdx.json'
        : format === 'cyclonedx'
          ? 'techstack-sbom-cyclonedx.json'
          : `techstack-report.${format}`;
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(report);
  } else {
    // No engine — fall back to raw JSON snapshot
    sendJson(res, 200, snapshot);
  }
}

/** GET /api/techstack/trends */
export async function handleTechStackTrends(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): Promise<void> {
  try {
    const { TrendStore } = await import('@wrongstack/techstack');
    sendJson(res, 200, { trend: new TrendStore(deps.store).analyze(deps.projectId) });
  } catch (error) {
    sendJson(res, 500, { error: 'Trend analysis failed', detail: errorMessage(error) });
  }
}

/** GET /api/techstack/remediation */
export async function handleTechStackRemediationPlan(
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): Promise<void> {
  const snapshot = deps.store.getSnapshot(deps.projectId);
  if (!snapshot) {
    sendJson(res, 404, { error: 'No TechStack snapshot is available' });
    return;
  }
  const { applyPlan, generateUpgradePlan } = await import('@wrongstack/techstack');
  const plan = generateUpgradePlan(snapshot);
  sendJson(res, 200, { plan, preview: await applyPlan(plan) });
}

/** POST /api/techstack/remediation/apply */
export async function handleTechStackRemediationApply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TechStackHandlerDeps,
): Promise<void> {
  if (!deps.executePackageOperation) {
    sendJson(res, 503, { error: 'Permission-governed package execution is unavailable' });
    return;
  }
  let approvedItems: string[];
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Request body is too large');
    }
    const body = JSON.parse(raw || '{}') as { approvedItems?: unknown };
    approvedItems = Array.isArray(body.approvedItems)
      ? body.approvedItems.filter((value): value is string => typeof value === 'string')
      : [];
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid request body', detail: errorMessage(error) });
    return;
  }
  if (approvedItems.length === 0) {
    sendJson(res, 400, { error: 'approvedItems must explicitly identify at least one plan item' });
    return;
  }
  const snapshot = deps.store.getSnapshot(deps.projectId);
  if (!snapshot) {
    sendJson(res, 404, { error: 'No TechStack snapshot is available' });
    return;
  }
  const approved = new Set(approvedItems);
  const executePackageOperation = deps.executePackageOperation;
  const { applyPlan, generateUpgradePlan } = await import('@wrongstack/techstack');
  const plan = generateUpgradePlan(snapshot);
  const result = await applyPlan(plan, {
    dryRun: false,
    approve: (item) =>
      approved.has(`${item.workspaceId}:${item.ecosystem}:${item.dependencyName}:${item.action}`),
    execute: (operation) => {
      const workspace = snapshot.workspaces.find((item) => item.id === operation.workspaceId);
      return executePackageOperation(operation, workspace?.relativeRoot);
    },
  });
  sendJson(res, 200, { plan, result });
}
