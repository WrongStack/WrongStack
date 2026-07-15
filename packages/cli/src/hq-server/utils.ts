/**
 * HQ server — general utility functions.
 *
 * @module hq-server/utils
 */

import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqEventEnvelope, HqPersistence, HqTranscriptEntry } from '@wrongstack/core';
import { resolveHqDataDir } from '@wrongstack/core';

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
    const { SessionRegistry, resolveWstackPaths, sessionScopedPath } = await import(
      '@wrongstack/core'
    );
    const globalRoot = path.dirname(resolveHqDataDir());
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);
    if (!entry) return null; // remote session — no local disk to read
    const paths = resolveWstackPaths({ projectRoot: entry.projectRoot, globalRoot });
    const sessionDir = sessionScopedPath(paths.projectSessions, sessionId, '');
    const file = path.join(sessionDir, 'subagents', 'transcripts', subagentId, 'transcript.jsonl');
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

/** Safe URL-decoding — returns null on malformed input. */
export function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
  return `${value.slice(0, maxLength)}…[truncated:${value.length - maxLength}]`;
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
        ...(typeof p.provider === 'string' && p.provider.length > 0 ? { provider: p.provider } : {}),
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
 * Coerce a thrown error into a safe, opaque message for HTTP/JSON API
 * responses. Raw error strings (file paths, environment details, stack
 * fragments) are never forwarded to the browser — only a stable category.
 * The original error is logged server-side by the caller.
 */
export function sanitizeApiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Classify a few well-known shapes without echoing their text verbatim.
  const lower = message.toLowerCase();
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return 'resource not found';
  }
  if (lower.includes('eacces') || lower.includes('permission')) {
    return 'permission denied';
  }
  if (lower.includes('json') && (lower.includes('parse') || lower.includes('unexpected'))) {
    return 'malformed data';
  }
  // Default: a generic label — the detail stays server-side.
  return 'internal error';
}
