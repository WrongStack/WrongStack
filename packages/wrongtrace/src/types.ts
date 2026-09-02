/**
 * Type contracts for the WrongTrace AI Observability adapter.
 *
 * The adapter speaks to an EXTERNAL daemon that may or may not be running
 * on the developer's machine. WrongStack does not own, ship, or bootstrap
 * that daemon — it just probes + talks to it when present, and silently
 * no-ops when it is absent. All types are deliberately narrow: we
 * declare exactly the surfaces the integration protocol promises, and
 * we let unknown fields stay `unknown` so we can forward them through.
 */

/** Result of `GET /api/health`. */
export interface WrongTraceHealth {
  ok: boolean;
  /** SemVer string of the running daemon, when the daemon reports it. */
  version?: string;
  /** Filesystem path of the IPC socket the daemon is listening on. */
  socket_path?: string;
  /** Anything else the daemon returned is preserved as-is for forward-compat. */
  [extra: string]: unknown;
}

/** `GET /api/file/health?path=...` response. Daemon 2026-08-24+: lock fields included. */
export interface WrongTraceFileHealth {
  file_path: string;
  /** 0..100. Lower = more fragile. */
  health_score: number;
  is_fragile: boolean;
  /** Number of write/delete cycles observed in the last 24h. */
  recent_thrashing_count: number;
  is_locked: boolean;
  lock_owner?: string;
  lock_reason?: string;
  lock_owner_run_id?: string;
  lock_expires_at?: string;
  warning?: string;
  [extra: string]: unknown;
}

/** `GET /api/symbol/history` row — one revision event per row (daemon returns an array). */
export interface WrongTraceSymbolEvent {
  event_id: string;
  run_id?: string;
  repo_name?: string;
  file_path: string;
  /** Daemon format: `function:file.go::Name` / `struct:file.go::Name` / `method:...`. */
  node_signature: string;
  node_type?: string;
  action?: string;
  ast_content_hash?: string;
  added_lines?: number;
  deleted_lines?: number;
  diff_snippet?: string;
  author_model?: string;
  event_time?: string;
  timestamp?: string;
  [extra: string]: unknown;
}

/** `GET /api/metrics/friction` — model-vs-model overwriter heatmap. */
export interface WrongTraceFrictionRow {
  author_model: string;
  overwriter_model: string;
  file_count: number;
  deleted_lines: number;
  [extra: string]: unknown;
}

/** One file entry inside a full (non-summary) atlas. */
export interface WrongTraceAtlasFile {
  path: string;
  name?: string;
  language?: string;
  health_score?: number;
  is_fragile?: boolean;
  recent_thrashing_count?: number;
  total_loc?: number;
  symbols?: unknown[];
}

/**
 * `GET /api/atlas` — repo-wide map. Two modes (daemon 2026-08-24+):
 *   full:      packages[].files[] with per-file health + AST symbols
 *   summary:   packages[] carry file_count / fragile_files_count / avg_health_score
 * Both modes carry top-level totals since the round-2 daemon update.
 */
export interface WrongTraceAtlasSummary {
  repo?: string;
  generated_at?: string;
  is_monorepo?: boolean;
  workspaces?: string[];
  total_packages?: number;
  total_files?: number;
  total_loc?: number;
  total_nodes?: number;
  index_status?: string;
  packages: Array<{
    path: string;
    name: string;
    workspace?: string;
    /** Summary mode only. */
    file_count?: number;
    /** Summary mode only. */
    fragile_files_count?: number;
    /** Summary mode only. */
    avg_health_score?: number;
    total_loc?: number;
    is_fragile?: boolean;
    /** Full mode only. */
    files?: WrongTraceAtlasFile[];
  }>;
  [extra: string]: unknown;
}

export interface WrongTraceAtlasQuery {
  /** Restrict the atlas to one workspace (e.g. "internal"). */
  workspace?: string;
  /** Summary mode: no per-file payloads, aggregate counters per package. */
  summary?: boolean;
  /** Strip AST symbol trees from files[] (~90% size cut) while keeping health scores. */
  includeSymbols?: boolean;
  /** Package-level pagination (daemon slices packages[], returns limit/offset meta). */
  limit?: number;
  offset?: number;
}

/** `POST /api/telemetry` payload. */
export interface WrongTraceTelemetryReport {
  run_id: string;
  task_id?: string;
  agent_name: string;
  model_name: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  intent: string;
  /** Free-form pass-through. */
  [extra: string]: unknown;
}

/** `POST /api/guardrail/{lock,unlock}` payloads. Daemon 2026-08-24+: ownership + TTL. */
export interface WrongTraceLockRequest {
  path: string;
  reason: string;
  owner?: string;
  owner_run_id?: string;
  /** Seconds until the lock self-expires (daemon-enforced TTL). */
  ttl_seconds?: number;
  /** Take over an existing lock (override a 409 conflict). */
  force?: boolean;
}

export interface WrongTraceUnlockRequest {
  path: string;
}

export interface WrongTraceLockResult {
  ok: boolean;
  path: string;
  status?: string;
  /** Set when the lock was rejected because someone else already owns it. */
  owner?: string;
  owner_run_id?: string;
  reason?: string;
  locked_at?: string;
  expires_at?: string;
  [extra: string]: unknown;
}

/** Caller-supplied lock ownership, mapped to the daemon's snake_case body. */
export interface WrongTraceLockOwnership {
  owner?: string;
  ownerRunId?: string;
  ttlSeconds?: number;
  /** Take over an existing lock (daemon 409-conflict override). */
  force?: boolean;
}

/** `GET /api/events/recent` row — daemon 2026-08-24+. */
export interface WrongTraceRecentEvent {
  event_id: string;
  run_id?: string;
  repo_name?: string;
  file_path: string;
  node_signature?: string;
  node_type?: string;
  action?: string;
  added_lines?: number;
  deleted_lines?: number;
  diff_snippet?: string;
  author_model?: string;
  event_time?: string;
  timestamp?: string;
  [extra: string]: unknown;
}

export interface WrongTraceRecentEventsQuery {
  limit?: number;
  /** ISO timestamp / SQLite datetime / Unix epoch (s or ms); only events after this. */
  since?: string;
  /** Repo name filter (e.g. "WrongTrace"). Omit for all repos. */
  repo?: string;
  /** Filter events to a single file path. */
  filePath?: string;
}

/** `GET /api/guardrail/locks` row — active locks listing, daemon 2026-08-24+. */
export interface WrongTraceLockInfo {
  path: string;
  status?: string;
  owner?: string;
  owner_run_id?: string;
  reason?: string;
  locked_at?: string;
  expires_at?: string;
  [extra: string]: unknown;
}

/**
 * The resolved, ready-to-use client. When `isAvailable` is false every
 * method degrades to a typed no-op (returns sensible defaults, never throws),
 * so callers can wire it unconditionally and forget the daemon is optional.
 */
export interface WrongTraceClient {
  readonly isAvailable: boolean;
  readonly baseUrl?: string | undefined;
  readonly socketPath?: string | undefined;
  /** `GET /api/health`. Returns `null` if the daemon is unreachable. */
  getHealth(): Promise<WrongTraceHealth | null>;
  /** `GET /api/file/health?path=...`. */
  getFileHealth(path: string): Promise<WrongTraceFileHealth | null>;
  /** `GET /api/symbol/history?path=...` — all symbol events for a file; add a
   *  daemon-format signature (`function:file.go::Name`) to narrow to one symbol. */
  getSymbolLineage(path: string, signature?: string): Promise<WrongTraceSymbolEvent[]>;
  /** `GET /api/metrics/friction?limit=50`. */
  getFrictionMatrix(limit?: number): Promise<WrongTraceFrictionRow[]>;
  /** `GET /api/atlas` — full or summary mode, optional workspace filter. */
  getAtlas(query?: WrongTraceAtlasQuery): Promise<WrongTraceAtlasSummary | null>;
  /** `POST /api/guardrail/lock`. Ownership/TTL options available since daemon 2026-08-24. */
  lockFile(
    path: string,
    reason: string,
    opts?: WrongTraceLockOwnership,
  ): Promise<WrongTraceLockResult | null>;
  /** `POST /api/guardrail/unlock`. */
  unlockFile(path: string): Promise<WrongTraceLockResult | null>;
  /** `POST /api/telemetry`. */
  reportTelemetry(report: WrongTraceTelemetryReport): Promise<{ ok: boolean } | null>;
  /** `GET /api/events/recent` — chronological event feed (daemon 2026-08-24+). */
  getRecentEvents(query?: WrongTraceRecentEventsQuery): Promise<WrongTraceRecentEvent[]>;
  /** `GET /api/guardrail/locks` — active locks (daemon 2026-08-24+). */
  listLocks(): Promise<WrongTraceLockInfo[]>;
}
