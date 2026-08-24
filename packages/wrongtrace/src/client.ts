/**
 * The integrated WrongTrace client.
 *
 *  ┌────────────────┐    ┌────────────────┐    ┌──────────────────┐
 *  │  HTTP / REST   │ ←→ │  WrongTrace    │ ←→ │  IPC / MCP opt.  │
 *  │  (always)      │    │  Client        │    │  (if discovered) │
 *  └────────────────┘    └────────────────┘    └──────────────────┘
 *
 * Strategy:
 *   - IPC-first: when `/api/health` reports a `socket_path`, JSON-RPC 2.0
 *     over the pipe is preferred for every method the daemon exposes there.
 *     Daemon v0.3.3 (live-verified 2026-08-24) answers telemetry/file_health,
 *     telemetry/report_run, guardrail/unlock and get_atlas on the pipe;
 *     older daemons reply -32601, which the transport surfaces as
 *     {result:null} → HTTP fallback, so routing is a no-op there.
 *   - ONE exception: guardrail/lock answers on the pipe but does NOT enforce
 *     conflicts — a live probe (2026-08-24) showed IPC lock with force:false
 *     silently TAKES OVER another owner's lock instead of rejecting with the
 *     -32009 envelope the integration letter promises. lockFile therefore
 *     stays HTTP-first to preserve the 409 conflict semantics production
 *     gates depend on. Flip it when the daemon enforces conflicts on IPC.
 *   - HTTP is the universal substrate — every method has an HTTP path and
 *     serves as the fallback when the pipe is absent or fails.
 *   - MCP is used when the host runtime supplies an MCP tool bag. In that
 *     mode we prefer IPC, then the named MCP tools (lock_file,
 *     get_file_health_score, etc.), then HTTP.
 *
 * Every method returns `null` (or `[]` for list endpoints) when the
 * underlying transport failed OR the daemon was never reachable. The
 * protocol promises callers can wire this client unconditionally and
 * "pass" when WrongTrace is offline.
 */

import { createMcpTransport, type McpToolBag } from "./adapters/mcp.js";
import { createIpcTransport, type IpcTransport } from "./adapters/ipc.js";
import { discover, type DiscoveryOptions, type DiscoveryResult } from "./discovery.js";
import type {
  WrongTraceAtlasSummary,
  WrongTraceClient,
  WrongTraceFileHealth,
  WrongTraceFrictionRow,
  WrongTraceHealth,
  WrongTraceLockInfo,
  WrongTraceLockOwnership,
  WrongTraceLockRequest,
  WrongTraceLockResult,
  WrongTraceAtlasQuery,
  WrongTraceSymbolEvent,
  WrongTraceRecentEvent,
  WrongTraceRecentEventsQuery,
  WrongTraceTelemetryReport,
  WrongTraceUnlockRequest,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 4_000;

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface WrongTraceClientOptions extends DiscoveryOptions {
  /** Optional MCP tool bag — typically `mcp_control.list()` output. */
  mcpTools?: McpToolBag;
}

export interface WrongTraceClientInternal extends WrongTraceClient {
  /** Internal: lets tests + integrations verify what was actually discovered. */
  readonly _discovery: DiscoveryResult;
}

async function httpJson<T>(
  baseUrl: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number; acceptStatus?: number[] },
): Promise<T | null> {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const reqInit: { method: string; signal: AbortSignal; headers: Record<string, string>; body?: string } = {
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers,
    };
    if (init?.body !== undefined) reqInit.body = JSON.stringify(init.body);
    const res = await fetchImpl(`${baseUrl}${path}`, reqInit);
    // Non-2xx statuses listed in acceptStatus carry a structured body the
    // caller wants (e.g. lock conflicts: 409 + {ok:false, owner, expires_at}).
    // Surface those bodies instead of swallowing them into null.
    if (!res.ok && !(init?.acceptStatus ?? []).includes(res.status)) {
      throw new HttpError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function createWrongTraceClient(
  opts: WrongTraceClientOptions = {},
): Promise<WrongTraceClientInternal> {
  const discovery = await discover(opts);
  const mcp = createMcpTransport(opts.mcpTools);
  const ipc: IpcTransport = createIpcTransport(discovery.socketPath);

  const requireBaseUrl = (): string | null => {
    if (!discovery.available || !discovery.baseUrl) return null;
    return discovery.baseUrl;
  };

  const notAvailable = (): null => null;

  const client: WrongTraceClientInternal = {
    _discovery: discovery,
    get isAvailable() {
      return discovery.available;
    },
    get baseUrl() {
      return discovery.baseUrl;
    },
    get socketPath() {
      return discovery.socketPath;
    },

    async getHealth(): Promise<WrongTraceHealth | null> {
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      return httpJson<WrongTraceHealth>(base, "/api/health");
    },

    async getFileHealth(path: string): Promise<WrongTraceFileHealth | null> {
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      // IPC-first: live-verified JSON-RPC method on the daemon's pipe
      // (both instances, 2026-08-24). Falls back to HTTP when the pipe is
      // absent, unreachable, or answers with an error envelope.
      if (ipc.isWired) {
        const viaIpc = await ipc.call<WrongTraceFileHealth>("telemetry/file_health", { file_path: path });
        if (viaIpc.result) return viaIpc.result;
      }
      if (mcp.isWired) {
        const viaMcp = await mcp.invoke<WrongTraceFileHealth>("get_file_health_score", { path });
        if (viaMcp) return viaMcp;
      }
      return httpJson<WrongTraceFileHealth>(base, `/api/file/health?path=${encodeURIComponent(path)}`);
    },

    async getSymbolLineage(
      path: string,
      signature?: string,
    ): Promise<WrongTraceSymbolEvent[]> {
      const base = requireBaseUrl();
      if (!base) return [];
      // Daemon round-3: signature is optional — path-only returns every
      // symbol event for the file. Loose names like "foo()" still yield [],
      // so callers wanting a specific symbol should pass a daemon-format
      // signature (`function:file.go::Name`); otherwise omit it.
      const params = new URLSearchParams();
      params.set("path", path);
      if (signature !== undefined && signature !== "") params.set("signature", signature);
      const data = await httpJson<unknown>(base, `/api/symbol/history?${params.toString()}`);
      return Array.isArray(data) ? (data as WrongTraceSymbolEvent[]) : [];
    },

    async getFrictionMatrix(limit = 50): Promise<WrongTraceFrictionRow[]> {
      const base = requireBaseUrl();
      if (!base) return [];
      const data = await httpJson<unknown>(base, `/api/metrics/friction?limit=${limit}`);
      // The daemon returns a report object ({edges, recent_collisions,
      // total_collisions, ...}), not a bare array. Normalize: bare array
      // passes through; report shape yields its edges, carrying
      // `recent_collisions` as metadata so single-call consumers
      // (getRecentActivity) don't lose the per-file collision history.
      if (Array.isArray(data)) return data as WrongTraceFrictionRow[];
      if (data && typeof data === "object") {
        const report = data as { edges?: unknown; recent_collisions?: unknown };
        if (Array.isArray(report.edges)) {
          const rows = report.edges as WrongTraceFrictionRow[] & { recent_collisions?: unknown };
          if (Array.isArray(report.recent_collisions)) rows.recent_collisions = report.recent_collisions;
          return rows;
        }
      }
      return [];
    },

    async getAtlas(query?: WrongTraceAtlasQuery): Promise<WrongTraceAtlasSummary | null> {
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      const params = new URLSearchParams();
      if (query?.workspace !== undefined && query.workspace !== "") params.set("workspace", query.workspace);
      if (query?.summary === true) params.set("summary", "true");
      if (query?.includeSymbols === false) params.set("include_symbols", "false");
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.offset !== undefined) params.set("offset", String(query.offset));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      // IPC-first since daemon v0.3.3 (live-verified 2026-08-24): get_atlas
      // answers JSON-RPC on the pipe. Older daemons reply -32601 →
      // {result:null} → HTTP fallback below. summary=true keeps the pipe
      // payload small; full atlases are multi-hundred-ms either transport.
      if (ipc.isWired) {
        const viaIpc = await ipc.call<WrongTraceAtlasSummary>("get_atlas", {
          ...(query?.workspace !== undefined && query.workspace !== "" ? { workspace: query.workspace } : {}),
          ...(query?.summary === true ? { summary: true } : {}),
          ...(query?.includeSymbols === false ? { include_symbols: false } : {}),
          ...(query?.limit !== undefined ? { limit: query.limit } : {}),
          ...(query?.offset !== undefined ? { offset: query.offset } : {}),
        });
        if (viaIpc.result) return viaIpc.result;
      }
      return httpJson<WrongTraceAtlasSummary>(base, `/api/atlas${qs}`);
    },

    async lockFile(
      path: string,
      reason: string,
      opts?: WrongTraceLockOwnership,
    ): Promise<WrongTraceLockResult | null> {
      // Deliberately HTTP-first — the ONE IPC exception; see the strategy
      // header. Live probe 2026-08-24: IPC guardrail/lock ignores conflicts
      // (silently takes over even with force:false), so routing lock calls
      // through the pipe would break the 409-conflict semantics the
      // production guardrail depends on.
      const body: WrongTraceLockRequest = { path, reason };
      if (opts?.owner !== undefined) body.owner = opts.owner;
      if (opts?.ownerRunId !== undefined) body.owner_run_id = opts.ownerRunId;
      if (opts?.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;
      if (opts?.force === true) body.force = true;
      if (mcp.isWired) {
        const viaMcp = await mcp.invoke<WrongTraceLockResult>("lock_file", { ...body });
        if (viaMcp) return viaMcp;
      }
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      // 409 = lock conflict: the daemon returns {ok:false, owner, owner_run_id,
      // locked_at, expires_at, error, message} — exactly what the caller needs
      // to decide whether to wait or take over, so pass the body through.
      return httpJson<WrongTraceLockResult>(base, "/api/guardrail/lock", {
        method: "POST",
        body,
        acceptStatus: [409],
      });
    },

    async unlockFile(path: string): Promise<WrongTraceLockResult | null> {
      // IPC-first since daemon v0.3.3 (live-verified 2026-08-24): the pipe
      // shares the daemon's lock store — an IPC unlock releases HTTP-acquired
      // locks. Shape differs from HTTP: {file_path, status} with no `ok`,
      // normalized here to the HTTP contract.
      if (ipc.isWired) {
        const viaIpc = await ipc.call<{ file_path?: string; path?: string; status?: string }>(
          "guardrail/unlock",
          { path },
        );
        if (viaIpc.result) {
          return {
            ok: true,
            path: viaIpc.result.path ?? viaIpc.result.file_path ?? path,
            status: viaIpc.result.status ?? "unlocked",
          };
        }
      }
      const body: WrongTraceUnlockRequest = { path };
      if (mcp.isWired) {
        const viaMcp = await mcp.invoke<WrongTraceLockResult>("unlock_file", { ...body });
        if (viaMcp) return viaMcp;
      }
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      return httpJson<WrongTraceLockResult>(base, "/api/guardrail/unlock", { method: "POST", body });
    },

    async reportTelemetry(report: WrongTraceTelemetryReport): Promise<{ ok: boolean } | null> {
      // IPC-first: telemetry/report_run is a live JSON-RPC method on the
      // daemon's pipe (both instances, 2026-08-24). HTTP fallback keeps the
      // no-op contract when the pipe is absent or fails.
      if (ipc.isWired) {
        const viaIpc = await ipc.call<{ ok?: boolean; status?: string }>("telemetry/report_run", {
          ...report,
        });
        if (viaIpc.result) {
          // Daemon answers {"status":"ok"} — normalize to the HTTP contract.
          const ok = viaIpc.result.ok ?? viaIpc.result.status === "ok";
          return { ok };
        }
      }
      if (mcp.isWired) {
        const viaMcp = await mcp.invoke<{ ok: boolean }>("report_telemetry", { ...report });
        if (viaMcp) return viaMcp;
      }
      const base = requireBaseUrl();
      if (!base) return notAvailable();
      return httpJson<{ ok: boolean }>(base, "/api/telemetry", { method: "POST", body: report });
    },

    async getRecentEvents(query?: WrongTraceRecentEventsQuery): Promise<WrongTraceRecentEvent[]> {
      const base = requireBaseUrl();
      if (!base) return [];
      const params = new URLSearchParams();
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.since !== undefined) params.set("since", query.since);
      if (query?.repo !== undefined) params.set("repo", query.repo);
      if (query?.filePath !== undefined) params.set("file_path", query.filePath);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      const data = await httpJson<unknown>(base, `/api/events/recent${qs}`);
      return Array.isArray(data) ? (data as WrongTraceRecentEvent[]) : [];
    },

    async listLocks(): Promise<WrongTraceLockInfo[]> {
      const base = requireBaseUrl();
      if (!base) return [];
      const data = await httpJson<unknown>(base, "/api/guardrail/locks");
      return Array.isArray(data) ? (data as WrongTraceLockInfo[]) : [];
    },
  };

  return client;
}
