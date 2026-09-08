/**
 * Opt-in per-request prompt-cache prefix probe.
 *
 * The question this answers is not "what is the hit ratio" — the session
 * ledger already reports that — but "WHICH PART of the request stopped
 * matching what the backend had cached". On a wire with no cache breakpoints
 * (OpenAI Responses / the ChatGPT Codex backend) the cached prefix is
 * `instructions` + `tools` + the input array in order, so a single byte that
 * moves near the front re-bills everything behind it, which by that point is
 * the whole conversation. A ratio alone cannot distinguish that from a cache
 * that simply expired between turns.
 *
 * So the probe fingerprints the three segments per request, diffs them against
 * the previous request of the SAME session, and appends one JSONL line saying
 * where the divergence was and how many characters it cost. The usage line
 * that follows carries what the backend actually charged, so a reader can pair
 * "prefix broke at item 4" with "cached_tokens collapsed to 0".
 *
 * Off unless `WRONGSTACK_CACHE_PROBE` is set (`1` for the default path, or a
 * path to write to). Nothing here runs — not a hash, not a stat — when it is
 * unset: an always-on instrument that hashes every input item on every request
 * would itself be a per-turn cost on the path it is measuring.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

/** Per-session fingerprint of the previous request's cacheable prefix. */
export interface CacheProbeFingerprint {
  instructions: string;
  instructionsChars: number;
  tools: string;
  toolsChars: number;
  /** One hash per input item, in wire order. */
  items: string[];
  /** Serialized length of each input item, in wire order. */
  itemChars: number[];
}

/** What changed between two consecutive requests of one session. */
export interface CacheProbeDiff {
  instructionsChanged: boolean;
  toolsChanged: boolean;
  /**
   * Index of the first input item whose bytes differ from the previous
   * request, or `null` when every shared item matched (append-only growth —
   * the healthy case).
   */
  firstDivergentItem: number | null;
  /** Characters of THIS request the previous request's cache entry can cover. */
  cacheablePrefixChars: number;
  /** Total characters in the cacheable segments of this request. */
  promptChars: number;
}

const MAX_TRACKED_SESSIONS = 32;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Fingerprint the cacheable segments of one request body.
 *
 * `items` are hashed individually rather than as one blob: the whole point is
 * to report WHERE the prefix broke, and a single hash over the array can only
 * report THAT it broke.
 */
export function fingerprintCacheProbe(segments: {
  instructions: string;
  tools: readonly unknown[] | undefined;
  items: readonly unknown[];
}): CacheProbeFingerprint {
  const toolsJson = JSON.stringify(segments.tools ?? []);
  const items: string[] = [];
  const itemChars: number[] = [];
  for (const item of segments.items) {
    const json = JSON.stringify(item ?? null);
    items.push(sha(json));
    itemChars.push(json.length);
  }
  return {
    instructions: sha(segments.instructions),
    instructionsChars: segments.instructions.length,
    tools: sha(toolsJson),
    toolsChars: toolsJson.length,
    items,
    itemChars,
  };
}

/**
 * Diff two fingerprints into the per-request cache verdict.
 *
 * `cacheablePrefixChars` is deliberately pessimistic in the two ways the wire
 * is: a changed `instructions` voids everything (it leads the prefix), and a
 * changed `tools` array voids everything after `instructions` — neither can be
 * partially reused, because the backend matches a prefix, not a diff.
 */
export function diffCacheProbe(
  prev: CacheProbeFingerprint | undefined,
  cur: CacheProbeFingerprint,
): CacheProbeDiff {
  const promptChars =
    cur.instructionsChars + cur.toolsChars + cur.itemChars.reduce((a, b) => a + b, 0);
  if (!prev) {
    return {
      instructionsChanged: false,
      toolsChanged: false,
      firstDivergentItem: null,
      cacheablePrefixChars: 0,
      promptChars,
    };
  }
  const instructionsChanged = prev.instructions !== cur.instructions;
  const toolsChanged = prev.tools !== cur.tools;

  let firstDivergentItem: number | null = null;
  const shared = Math.min(prev.items.length, cur.items.length);
  for (let i = 0; i < shared; i++) {
    if (prev.items[i] !== cur.items[i]) {
      firstDivergentItem = i;
      break;
    }
  }

  let cacheablePrefixChars = 0;
  if (instructionsChanged) {
    cacheablePrefixChars = 0;
  } else if (toolsChanged) {
    cacheablePrefixChars = cur.instructionsChars;
  } else {
    cacheablePrefixChars = cur.instructionsChars + cur.toolsChars;
    const upTo = firstDivergentItem ?? shared;
    for (let i = 0; i < upTo; i++) cacheablePrefixChars += cur.itemChars[i] ?? 0;
  }

  return {
    instructionsChanged,
    toolsChanged,
    firstDivergentItem,
    cacheablePrefixChars,
    promptChars,
  };
}

// ── the opt-in recorder ─────────────────────────────────────────────────────

let enabledCache: string | null | undefined;

/** Resolved output path, or null when the probe is off. */
function probePath(): string | null {
  if (enabledCache !== undefined) return enabledCache;
  const raw = process.env['WRONGSTACK_CACHE_PROBE'];
  if (!raw || raw === '0' || raw === 'false') {
    enabledCache = null;
    return null;
  }
  enabledCache =
    raw === '1' || raw === 'true'
      ? path.join(wstackGlobalRoot(), 'cache-probe.jsonl')
      : path.resolve(raw);
  return enabledCache;
}

/** Test seam — the env var is read once per process in normal operation. */
export function resetCacheProbeState(): void {
  enabledCache = undefined;
  lastBySession.clear();
}

/** Whether anything below will do work. Callers guard on this before building segments. */
export function isCacheProbeEnabled(): boolean {
  return probePath() !== null;
}

const lastBySession = new Map<string, CacheProbeFingerprint>();

function append(line: Record<string, unknown>): void {
  const file = probePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // A diagnostic must never be able to fail a request.
  }
}

/**
 * Record one request's prefix verdict. `sessionKey` must be the same value the
 * wire sends as its cache partition key, so the probe compares exactly what
 * the backend compares.
 */
export function recordCacheProbeRequest(input: {
  provider: string;
  sessionKey: string;
  model: string;
  instructions: string;
  tools: readonly unknown[] | undefined;
  items: readonly unknown[];
}): void {
  if (!isCacheProbeEnabled()) return;
  const cur = fingerprintCacheProbe(input);
  const prev = lastBySession.get(input.sessionKey);
  const diff = diffCacheProbe(prev, cur);

  lastBySession.delete(input.sessionKey);
  lastBySession.set(input.sessionKey, cur);
  while (lastBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastBySession.keys().next().value;
    if (oldest === undefined) break;
    lastBySession.delete(oldest);
  }

  append({
    kind: 'req',
    ts: new Date().toISOString(),
    provider: input.provider,
    session: input.sessionKey,
    model: input.model,
    first: prev === undefined,
    items: cur.items.length,
    prevItems: prev?.items.length ?? 0,
    instructionsChars: cur.instructionsChars,
    toolsChars: cur.toolsChars,
    instructionsChanged: diff.instructionsChanged,
    toolsChanged: diff.toolsChanged,
    firstDivergentItem: diff.firstDivergentItem,
    cacheablePrefixChars: diff.cacheablePrefixChars,
    promptChars: diff.promptChars,
    // What the transport could reuse if the entry is still alive server-side.
    // Compared against the usage line's real `cacheRead`, the gap between the
    // two separates "we broke the prefix" from "the entry expired".
    expectedHitPct:
      diff.promptChars > 0 ? Math.round((diff.cacheablePrefixChars / diff.promptChars) * 100) : 0,
  });
}

/** Record what the backend actually charged for the request just sent. */
export function recordCacheProbeUsage(input: {
  provider: string;
  sessionKey: string;
  usage: { input: number; output: number; cacheRead?: number | undefined };
}): void {
  if (!isCacheProbeEnabled()) return;
  const cacheRead = input.usage.cacheRead ?? 0;
  const prompt = input.usage.input + cacheRead;
  append({
    kind: 'usage',
    ts: new Date().toISOString(),
    provider: input.provider,
    session: input.sessionKey,
    promptTokens: prompt,
    cachedTokens: cacheRead,
    outputTokens: input.usage.output,
    actualHitPct: prompt > 0 ? Math.round((cacheRead / prompt) * 100) : 0,
  });
}
