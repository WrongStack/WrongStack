/**
 * Agent-facing helpers — opinionated wrappers over the raw WrongTrace
 * client that turn multi-call queries into single, decision-ready values.
 *
 * Why this file exists:
 *   The base client returns rich-but-unopinionated JSON (friction edges,
 *   atlas nodes, file health rows). An agent deciding whether to edit a
 *   file should not have to fuse those three calls by hand. These helpers
 *   produce ONE number, ONE sentence, ONE list — the things an agent or a
 *   prompt actually consumes.
 *
 * Every helper degrades gracefully when WrongTrace is offline: it returns
 * a typed "no-op" shape that the caller can wire unconditionally.
 */

import type { WrongTraceAtlasSummary, WrongTraceClient, WrongTraceFrictionRow } from './types.js';

/* ------------------------------------------------------------------ *
 * 1. Cross-agent edit risk for a single file path.                   *
 * ------------------------------------------------------------------ */

/**
 * Combines `getFileHealth(path)` + `getFrictionMatrix()` into one
 * decision-ready score. Returns:
 *   - `risk`: 0..100 — how dangerous editing this file is RIGHT NOW
 *   - `band`: "safe" | "caution" | "fragile" | "locked" | "unknown"
 *   - `reasons`: human-readable bullet list for prompt injection
 *
 * Heuristic (documented so the numbers don't drift silently):
 *   - file.is_locked         → 100, "locked"
 *   - file.health_score <40  → base 80, "fragile"
 *   - file.recent_thrashing  → +5 per event above 3, cap at +25
 *   - friction: this file's
 *     author_model vs top
 *     overwriter_model      → +20 if conflict_count >= 3
 *   - all multipliers cap at 100.
 *
 * The `path` → friction join is intentionally fuzzy: the daemon's
 * friction matrix does not always carry a per-file field, so when no
 * row mentions `path`, we attribute only the file-health signals. This
 * keeps the helper robust against daemon schema drift.
 */
export interface CrossAgentRisk {
  path: string;
  risk: number;
  band: 'safe' | 'caution' | 'fragile' | 'locked' | 'unknown';
  reasons: string[];
}

export async function getCrossAgentRisk(
  wt: WrongTraceClient,
  path: string,
  frictionLimit = 50,
  /** Caller's lock-owner identity (`wrongstack:<sessionId>`). A lock the
   *  caller itself holds (e.g. leaked by an interrupted earlier edit) is
   *  exempted — it must not deny the session's own retry. */
  selfOwner?: string,
): Promise<CrossAgentRisk> {
  if (!wt.isAvailable) {
    return {
      path,
      risk: 0,
      band: 'unknown',
      reasons: ['WrongTrace offline — no signal available'],
    };
  }

  const health = await wt.getFileHealth(path);
  const friction = await wt.getFrictionMatrix(frictionLimit);

  if (health?.is_locked) {
    // Self-owner exemption: a live lock claimed by THIS session is not a
    // foreign conflict. The acquire happens in preToolUse, so a retry or a
    // leaked own lock must fall through to health scoring instead of
    // hard-blocking the session's own edit path.
    if (selfOwner !== undefined && health.lock_owner === selfOwner) {
      const exempted = await scoreFromHealth(path, health, friction);
      exempted.reasons.unshift(`own lock held (owner ${selfOwner}) — exempted`);
      return exempted;
    }

    const expiresAt = health.lock_expires_at ? Date.parse(health.lock_expires_at) : Number.NaN;
    const hasExpiry = !Number.isNaN(expiresAt);

    // A lock whose TTL already elapsed is stale — the daemon may not have
    // reaped it yet. Treat it as unlocked (fall through to health scoring)
    // so a dead lock can never block an edit forever.
    if (hasExpiry && expiresAt <= Date.now()) {
      // fall through to normal scoring below; note the stale lock.
      const staleReason = `stale lock ignored (expired at ${health.lock_expires_at})`;
      const base = await scoreFromHealth(path, health, friction);
      base.reasons.unshift(staleReason);
      return base;
    }

    const ownerNote = health.lock_owner ? ` by ${health.lock_owner}` : '';
    const reasonNote = health.lock_reason ? `: ${health.lock_reason}` : '';
    const expiryNote = hasExpiry
      ? `, expires ${new Date(expiresAt).toISOString()}`
      : ' (no expiry — daemon TTL missing, treat as held)';
    return {
      path,
      risk: 100,
      band: 'locked',
      reasons: [`file is locked${ownerNote}${reasonNote}${expiryNote}`],
    };
  }

  if (health) {
    return scoreFromHealth(path, health, friction);
  }

  return { path, risk: 50, band: 'unknown', reasons: ['file health endpoint unreachable'] };
}

/** Shared scoring used both directly and after a stale-lock fallthrough. */
async function scoreFromHealth(
  path: string,
  health: NonNullable<Awaited<ReturnType<WrongTraceClient['getFileHealth']>>>,
  friction: WrongTraceFrictionRow[],
): Promise<CrossAgentRisk> {
  const reasons: string[] = [];
  let risk = 0;

  if (health.is_fragile || health.health_score < 40) {
    risk = Math.max(risk, 80);
    reasons.push(`file is fragile (health_score=${health.health_score})`);
  } else if (health.health_score < 70) {
    risk = Math.max(risk, 45);
    reasons.push(`health_score below 70 (${health.health_score})`);
  }

  if (health.recent_thrashing_count > 3) {
    const thrashPenalty = Math.min(25, (health.recent_thrashing_count - 3) * 5);
    risk = Math.min(100, risk + thrashPenalty);
    reasons.push(
      `${health.recent_thrashing_count} recent write/delete cycles in last 24h (+${thrashPenalty})`,
    );
  }

  // Path-aware friction lookup: best-effort, daemon schema may not carry file_path.
  const fileFriction = friction.filter((row) => {
    const r = row as WrongTraceFrictionRow & { file_path?: string; files?: string[] };
    if (typeof r.file_path === 'string') return r.file_path === path;
    if (Array.isArray(r.files)) return r.files.includes(path);
    return false;
  });
  if (fileFriction.length > 0) {
    const totalConflicts = fileFriction.reduce((acc, r) => {
      const raw = (r as { conflict_count?: unknown }).conflict_count;
      return acc + (typeof raw === 'number' ? raw : 0);
    }, 0);
    if (totalConflicts >= 3) {
      risk = Math.min(100, risk + 20);
      reasons.push(`${totalConflicts} cross-agent conflicts on this file in friction matrix (+20)`);
    }
  }

  const band: CrossAgentRisk['band'] =
    risk >= 80 ? 'fragile' : risk >= 50 ? 'caution' : risk > 0 ? 'safe' : 'safe';

  if (reasons.length === 0) reasons.push('no risk signals — file is healthy');

  return { path, risk, band, reasons };
}

/* ------------------------------------------------------------------ *
 * 2. Short, prompt-ready friction summary.                           *
 * ------------------------------------------------------------------ */

/**
 * Condenses `getFrictionMatrix()` into a short, prompt-ready string:
 *
 *   "Top friction pair: MiniMax-M3 ↔ gemini-3.7-flash (3 conflicts).
 *    Cross-agent ratio: 40% of 10 collisions. Self-thrash: 60%."
 *
 * Returns "" when no signal is available — the caller can drop the
 * block from the prompt without branching.
 */
export interface FrictionSummary {
  topPair: string | null;
  crossAgentRatioPct: number;
  selfThrashRatioPct: number;
  totalCollisions: number;
  prose: string;
}

interface FrictionReport {
  edges?: Array<WrongTraceFrictionRow & { conflict_count?: number }>;
  recent_collisions?: unknown[];
  total_collisions?: number;
  cross_agent_ratio_pct?: number;
}

export function summarizeFriction(friction: unknown): FrictionSummary {
  const empty: FrictionSummary = {
    topPair: null,
    crossAgentRatioPct: 0,
    selfThrashRatioPct: 0,
    totalCollisions: 0,
    prose: '',
  };
  if (!friction || typeof friction !== 'object') return empty;
  const r = friction as FrictionReport;
  const edges = Array.isArray(r.edges) ? r.edges : [];
  const total = typeof r.total_collisions === 'number' ? r.total_collisions : edges.length;
  if (total === 0) return empty;

  // Find top pair by total conflict_count across both directions.
  const pairTotals = new Map<string, { count: number; a: string; b: string }>();
  for (const e of edges) {
    const key = [e.author_model, e.overwriter_model].sort().join('|');
    const raw = (e as { conflict_count?: unknown }).conflict_count;
    const c = typeof raw === 'number' ? raw : 0;
    const cur = pairTotals.get(key);
    if (cur) cur.count = cur.count + c;
    else pairTotals.set(key, { count: c, a: e.author_model, b: e.overwriter_model });
  }
  const topEntry = [...pairTotals.values()].sort((x, y) => y.count - x.count)[0];
  const topPair = topEntry ? `${topEntry.a} ↔ ${topEntry.b} (${topEntry.count} conflicts)` : null;

  // Ratio units must match. `total` is a COLLISION count when the report
  // carries `total_collisions`, so self-thrash must be weighted by each
  // edge's conflict_count (falling back to one collision per edge when the
  // count is missing) — the old per-EDGE count inflated the cross-agent
  // share (99% instead of the true 50/50) and went NEGATIVE when
  // self-thrash edges outnumbered total_collisions. When the report omits
  // total_collisions, `total` is an edge count and per-edge counting is the
  // correct unit. Percentages are clamped to [0,100] so a self-thrash
  // collision sum bigger than the daemon's windowed total renders 100%,
  // never 1433%.
  const collisionUnits = typeof r.total_collisions === 'number';
  const selfThrash = edges.reduce((acc, e) => {
    if (!e.is_self_thrash) return acc;
    if (!collisionUnits) return acc + 1;
    const raw = (e as { conflict_count?: unknown }).conflict_count;
    return acc + (typeof raw === 'number' ? raw : 1);
  }, 0);
  const crossAgent = Math.max(0, total - selfThrash);
  const crossAgentRatioPct = total > 0 ? Math.min(100, Math.round((crossAgent / total) * 100)) : 0;
  const selfThrashRatioPct = total > 0 ? Math.min(100, Math.round((selfThrash / total) * 100)) : 0;

  const prose =
    (topPair ? `Top friction pair: ${topPair}. ` : '') +
    `Cross-agent ratio: ${crossAgentRatioPct}% of ${total} collisions. ` +
    `Self-thrash: ${selfThrashRatioPct}%.`;

  return { topPair, crossAgentRatioPct, selfThrashRatioPct, totalCollisions: total, prose };
}

/* ------------------------------------------------------------------ *
 * 3. Recent activity for a file — who touched it recently?           *
 * ------------------------------------------------------------------ */

interface RecentEvent {
  file_path?: string;
  action?: string;
  author_model?: string;
  author_run_id?: string;
  author_time?: string;
  overwriter_model?: string;
  overwriter_run_id?: string;
  overwriter_time?: string;
}

interface EventsReport {
  events?: RecentEvent[];
  recent_collisions?: RecentEvent[];
}

export interface RecentActivityEntry {
  at: string;
  actor: string;
  action: string;
  runId?: string | undefined;
}

/**
 * Returns a chronological list of recent activity events for a file,
 * sourcing from both the friction matrix's `recent_collisions` and any
 * dedicated events endpoint exposed by the daemon.
 *
 * Returns [] when no events are available or the daemon is offline —
 * the caller can treat an empty result as "no history known".
 */
export async function getRecentActivity(
  wt: WrongTraceClient,
  filePath: string,
  limit = 10,
): Promise<RecentActivityEntry[]> {
  if (!wt.isAvailable) return [];

  // Friction's recent_collisions is the most reliable signal today.
  // The daemon does not yet expose a per-file events endpoint (see
  // Missing-Endpoints report), so this is our primary source.
  const matrix = (await getFrictionRaw(wt, limit * 5)) as EventsReport;
  const collisions = Array.isArray(matrix.recent_collisions) ? matrix.recent_collisions : [];
  const events = Array.isArray(matrix.events) ? matrix.events : [];

  const all = [...events, ...collisions];
  const matched: RecentActivityEntry[] = [];
  for (const ev of all) {
    if (typeof ev.file_path !== 'string' || ev.file_path !== filePath) continue;
    const at = ev.overwriter_time ?? ev.author_time ?? '';
    if (!at) continue;
    const entry: RecentActivityEntry = {
      at,
      actor: ev.overwriter_model ?? ev.author_model ?? 'unknown',
      action: ev.action ?? 'MODIFIED',
    };
    const runId = ev.overwriter_run_id ?? ev.author_run_id;
    if (runId) entry.runId = runId;
    matched.push(entry);
  }
  matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return matched.slice(0, limit);
}

async function getFrictionRaw(wt: WrongTraceClient, limit: number): Promise<unknown> {
  // We piggyback on getFrictionMatrix's underlying call by issuing one HTTP
  // request. Since the client doesn't expose raw access, we read the
  // matrix through a dedicated call. Reusing getFrictionMatrix keeps the
  // helper testable without leaking transport details.
  return wt.getFrictionMatrix(limit);
}

/* ------------------------------------------------------------------ *
 * 4. Atlas digest — project health at a glance.                      *
 * ------------------------------------------------------------------ */

/**
 * Summarizes `getAtlas()` for boot prompts:
 *   - workspace count
 *   - fragile-file count (health_score < 40 OR is_fragile)
 *   - self-thrash-heavy workspaces (those with >5 recent_thrashing files)
 *
 * Returns null when no atlas is available — the caller can skip
 * the prompt block.
 */
export interface AtlasDigest {
  workspaceCount: number;
  fragileFileCount: number;
  selfThrashWorkspaces: string[];
  prose: string;
}

interface AtlasPackage {
  name: string;
  files?: Array<{
    health_score?: number;
    is_fragile?: boolean;
    recent_thrashing_count?: number;
  }>;
}

interface AtlasShape {
  workspaces?: string[];
  packages?: AtlasPackage[];
}

export function digestAtlas(atlas: WrongTraceAtlasSummary | AtlasShape | null): AtlasDigest | null {
  if (!atlas) return null;
  const a = atlas as AtlasShape;
  const workspaces = Array.isArray(a.workspaces) ? a.workspaces : [];
  const packages = Array.isArray(a.packages) ? a.packages : [];

  let fragileFileCount = 0;
  const thrashCounts = new Map<string, number>();

  for (const pkg of packages) {
    const files = pkg.files ?? [];
    for (const f of files) {
      if ((f.health_score ?? 100) < 40 || f.is_fragile === true) fragileFileCount++;
      const thrash = f.recent_thrashing_count ?? 0;
      if (thrash > 5) thrashCounts.set(pkg.name, (thrashCounts.get(pkg.name) ?? 0) + 1);
    }
  }

  const selfThrashWorkspaces = [...thrashCounts.entries()]
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([name]) => name);

  const prose =
    `Atlas: ${workspaces.length || packages.length} workspaces, ` +
    `${fragileFileCount} fragile files, ` +
    (selfThrashWorkspaces.length > 0
      ? `self-thrash hotspots: ${selfThrashWorkspaces.join(', ')}.`
      : 'no self-thrash hotspots.');

  return {
    workspaceCount: workspaces.length || packages.length,
    fragileFileCount,
    selfThrashWorkspaces,
    prose,
  };
}
