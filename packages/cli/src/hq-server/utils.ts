/**
 * HQ server — general utility functions.
 *
 * @module hq-server/utils
 */

import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqEventEnvelope, HqPersistence, HqTranscriptEntry } from '@wrongstack/core/hq';
import { resolveHqDataDir } from '@wrongstack/core/hq';

// ── Constants ──────────────────────────────────────────────────────────────

export const TRANSCRIPT_RING_MAX = 4000;
export const MAX_TRANSCRIPT_SESSIONS = 400;
export const MAX_AGENT_RINGS = 800;

// ── Map eviction (LRU-by-insertion-order) ──────────────────────────────────

/**
 * Evict oldest entries from a Map until its size ≤ max.
 * Maps are insertion-ordered, so iterating keys() gives the oldest first.
 */
export function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ── Transcript helpers ─────────────────────────────────────────────────────

/**
 * Ring key for one subagent's transcript. Scoped by session so same-named
 * agents in different sessions (every leader is id 'leader') stay separate.
 * Falls back to the bare subId when no session id is known (legacy clients).
 */
export function agentRingKey(sessionId: string | undefined, subId: string): string {
  return sessionId ? `${sessionId}::${subId}` : subId;
}

/**
 * Convert an `agent.message` payload record into a `HqTranscriptEntry` that
 * is compact and viewable in the HQ session timeline. Mirrors the mapping the
 * TUI-side buffered-transcript writer applies so the HQ stream looks
 * identically to the live stream (thinking→thinking, system/status→system).
 */
export function agentMessageToEntry(p: Record<string, unknown>): HqTranscriptEntry {
  const kind = typeof p['kind'] === 'string' ? p['kind'] : 'text';
  const role: HqTranscriptEntry['role'] =
    kind === 'thinking'
      ? 'thinking'
      : kind === 'tool_use' || kind === 'tool_result'
        ? 'tool'
        : kind === 'error'
          ? 'error'
          : kind === 'status' || kind === 'system'
            ? 'system'
            : 'assistant';
  return {
    ts: typeof p['ts'] === 'string' ? p['ts'] : new Date().toISOString(),
    role,
    text: typeof p['content'] === 'string' ? p['content'] : '',
    ...(typeof p['toolName'] === 'string' ? { tool: p['toolName'] } : {}),
    ...(kind === 'error' ? { isError: true } : {}),
  };
}

/**
 * Read one local subagent's FULL conversation from disk. The agent monitor
 * writes every timeline entry to
 *   <projectSessions>/<sessionId>/subagents/transcripts/<subId>/transcript.jsonl
 * so for sessions on THIS machine we can serve the complete history — not
 * just the ≤4000-entry live ring. Returns null when the session isn't local
 * or the file is absent (caller falls back to the ring).
 */
export async function readLocalSubagentTranscript(
  sessionId: string,
  subagentId: string,
): Promise<HqTranscriptEntry[] | null> {
  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const { resolveWstackPaths, sessionScopedPath } = await import('@wrongstack/core/utils');
    const globalRoot = path.dirname(resolveHqDataDir());
    const registry = getSessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);
    if (!entry) return null; // remote session — no local disk to read
    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const sessionDir = sessionScopedPath(paths.projectSessions, sessionId, '');
    // WS-019: `subagentId` reaches here from a URL path segment.
    // `decodePathSegment` already refuses anything that is not a plain
    // component, so this is the second lock rather than the first — but a
    // read guarded only at its caller is one refactor away from being
    // unguarded, and this function is exported.
    if (!isSafePathSegment(subagentId)) return null;
    const transcriptsRoot = path.resolve(sessionDir, 'subagents', 'transcripts');
    const file = path.resolve(transcriptsRoot, subagentId, 'transcript.jsonl');
    // Containment, verified on the resolved path rather than inferred from the
    // input: whatever the segment rule missed, the read still cannot leave the
    // session's own transcript directory.
    if (!file.startsWith(transcriptsRoot + path.sep)) return null;
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw === null) return null;
    const out: HqTranscriptEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(agentMessageToEntry(JSON.parse(trimmed) as Record<string, unknown>));
      } catch {
        // Skip a torn/partial trailing line — best-effort replay.
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ── String/path utilities ──────────────────────────────────────────────────

/**
 * Percent-decode ONE URL path segment and reject anything that is not a safe
 * single path component.
 *
 * WS-019: this used to be `decodeURIComponent` and nothing else, and its
 * output is joined straight onto a filesystem path in
 * {@link readLocalSubagentTranscript}. `%2e%2e%2f` decodes to `../`, so a
 * request could walk out of the session's transcript directory and read any
 * `transcript.jsonl` on the machine — other projects' sessions included.
 * Percent-decoding is the step that CREATES the traversal, so validating
 * before decoding would have checked the wrong string.
 *
 * The rule is a whole path component or nothing: no separators, no `.`/`..`,
 * no NUL, no drive-letter colon, non-empty, and length-bounded. Real ids are
 * generated tokens, so nothing legitimate is excluded.
 */
export function decodePathSegment(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return isSafePathSegment(decoded) ? decoded : null;
}

/**
 * Percent-decode a session id that may contain a date-shard separator.
 *
 * Session ids are `YYYY-MM-DD/sess_<ULID>` (see `generateSessionId`), so a
 * literal `/` is legitimate. This decoder allows that one shape while still
 * blocking traversal (`..`, backslash, NUL, drive-relative forms). The
 * resolved-path containment check in {@link readLocalSubagentTranscript}
 * is the second lock.
 */
export function decodeSessionId(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return isSafeSessionId(decoded) ? decoded : null;
}

/** Longest id accepted in a path position. */
const MAX_PATH_SEGMENT_LENGTH = 256;

/**
 * True when `value` is usable as exactly one filesystem path component.
 *
 * Exported so the traversal rule has one definition — a second copy is how a
 * guard and its callers drift apart, which is the shape of several findings in
 * this audit.
 */
export function isSafePathSegment(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_SEGMENT_LENGTH) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  // A Windows drive-relative form (`C:foo`) is not a plain component.
  if (value.includes(':')) return false;
  return true;
}

/**
 * Session IDs are `YYYY-MM-DD/sess_<ULID>` — one forward slash is the
 * date-shard separator. Legacy flat ids (no slash) remain readable too
 * (`generateSessionId` in core/storage/session-id.ts), so accept one OR two
 * components while blocking everything that {@link isSafePathSegment} blocks:
 * no backslash, NUL, or drive-relative colon; no `.`/`..`; no empty component;
 * no deeper nesting (three or more components). The resolved-path containment
 * check in `sessionScopedPath` (core/utils) is the second lock.
 */
export function isSafeSessionId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_SEGMENT_LENGTH) return false;
  if (value.includes('\\') || value.includes('\0') || value.includes(':')) return false;
  const parts = value.split('/');
  if (parts.length > 2) return false;
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..');
}

/** Normalize display host — "0.0.0.0" prints as "127.0.0.1" for user-facing URLs. */
export function displayHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

// ── HTTP body helpers ──────────────────────────────────────────────────────

class RequestBodyTooLargeError extends Error {}

/** Read the full body of an HTTP request as a UTF-8 string (capped at 1 MB). */
export function readRequestBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

export function writeInvalidBody(res: http.ServerResponse, error: unknown): void {
  const tooLarge = error instanceof RequestBodyTooLargeError;
  res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: tooLarge ? 'request body too large' : 'invalid json body' }));
}

// ── URL builders ───────────────────────────────────────────────────────────

export function buildHttpUrl(host: string, port: number, token?: string): string {
  const url = new URL(`http://${displayHost(host)}:${port}/`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Build the browser startup URL with a one-time bootstrap code in the
 * fragment (`#bootstrap=…`). Fragments never reach HTTP access logs,
 * Referer headers, or proxy caches — unlike query-string tokens. The
 * SPA extracts the fragment, POSTs it to `/api/auth/bootstrap`, and
 * receives only an HttpOnly session cookie.
 */
export function buildBootstrapHttpUrl(host: string, port: number, bootstrapCode: string): string {
  const url = new URL(`http://${displayHost(host)}:${port}/`);
  url.hash = `bootstrap=${bootstrapCode}`;
  return url.toString();
}

export function buildClientWsUrl(host: string, port: number, token?: string): string {
  const url = new URL(`ws://${displayHost(host)}:${port}/ws/client`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

// ── Runtime marker ─────────────────────────────────────────────────────────

export function hqRuntimeMarkerPath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json');
}

// ── LAN addresses ──────────────────────────────────────────────────────────

/** Non-internal IPv4 addresses, so we can print URLs reachable from other machines. */
export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch {
    // best-effort
  }
  return out;
}

// ── String truncation (safe for summaries) ─────────────────────────────────

export function truncateHqSummary(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length <= maxLength) return value;
  // Reserve the suffix's length INSIDE the cap so the total never exceeds
  // maxLength — the old code appended "…[truncated:N]" on top of the capped
  // prefix, so a summary could come out longer than both the cap and the
  // original input. When the cap cannot even fit the suffix, emit a bare
  // ellipsis rather than overflow.
  const suffix = `…[truncated:${value.length - maxLength}]`;
  if (maxLength <= suffix.length) return '…';
  const prefixLen = maxLength - suffix.length;
  return `${value.slice(0, prefixLen)}${suffix}`;
}

// ── Machine key ────────────────────────────────────────────────────────────

/**
 * Stable per-machine key. Prefers hostname so the same physical computer maps
 * to one machine even when clients report different per-process machineIds
 * (older builds hashed `hostname:pid`). Falls back to machineId.
 */
export function hqMachineKey(hostname: string | undefined, machineId: string | undefined): string {
  const hn = hostname?.trim();
  return hn ? `host:${hn.toLowerCase()}` : `mid:${machineId || 'local'}`;
}

// ── Timeseries signal extraction ───────────────────────────────────────────

/**
 * Fold a cost/tool signal from an event envelope into the timeseries store.
 * Recognizes `session.usage` (cost/tokens, plus model/provider/cache
 * dimensions) and `tool.completed` (tool call). Best-effort, never throws.
 */
export function recordTimeseriesSignal(persistence: HqPersistence, event: HqEventEnvelope): void {
  try {
    if (event.type === 'session.usage') {
      const p = event.payload as {
        costUsd?: number;
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
        provider?: string;
        cacheRead?: number;
        cacheWrite?: number;
      };
      persistence.timeseries.record({
        ts: Date.parse(event.timestamp) || Date.now(),
        ...(typeof p.costUsd === 'number' ? { costUsd: p.costUsd } : {}),
        ...(typeof p.inputTokens === 'number' ? { inputTokens: p.inputTokens } : {}),
        ...(typeof p.outputTokens === 'number' ? { outputTokens: p.outputTokens } : {}),
        ...(typeof p.model === 'string' && p.model.length > 0 ? { model: p.model } : {}),
        ...(typeof p.provider === 'string' && p.provider.length > 0
          ? { provider: p.provider }
          : {}),
        ...(typeof p.cacheRead === 'number' ? { cacheRead: p.cacheRead } : {}),
        ...(typeof p.cacheWrite === 'number' ? { cacheWrite: p.cacheWrite } : {}),
      });
    } else if (event.type === 'tool.completed') {
      persistence.timeseries.record({
        ts: Date.parse(event.timestamp) || Date.now(),
        toolCalls: 1,
      });
    }
  } catch {
    /* best-effort */
  }
}

// ── API error sanitization ─────────────────────────────────────────────────

/**
 * Re-exported from `@wrongstack/core/security`.
 *
 * WS-066: this used to be an HQ-local implementation, which is why the WebUI
 * and SimpleUI servers — which have the same JSON-API surface — never adopted
 * it and forwarded `String(err)` verbatim instead. One implementation now
 * serves every server surface.
 */
export { sanitizeApiError, scrubErrorDetail } from '@wrongstack/core/security';
