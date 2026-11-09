import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { TokenMetrics, ToolMetrics } from './types.js';

/** A minimally typed event from a persisted session JSONL file. */
export type SessionLogEvent = Record<string, unknown>;

/**
 * Edit-family tools. The fraction of these that apply cleanly is the
 * edit-accuracy signal Aider's polyglot benchmark cares about. Kept inclusive
 * so it stays correct if more edit tools are added later.
 */
const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'replace',
  'patch',
  'multiedit',
  'multi_edit',
  'str_replace',
  'apply_patch',
  'replace_file_content',
  'write_to_file',
]);

/**
 * Derive model-free tool metrics from the isolated session JSONL the
 * subprocess wrote. Everything here comes from `tool_call_end` events
 * (`{ name, ok }`) and provider retry/error events — no LLM, no heuristics.
 *
 * Returns zeroed metrics (never throws) when the session log is missing or
 * unreadable: a crashed run still produces a valid, gradeable TaskResult.
 */
export async function readToolMetrics(opts: {
  homeDir: string;
  /** The task workdir — the subprocess used this as its projectRoot. */
  workdir: string;
}): Promise<ToolMetrics> {
  const empty: ToolMetrics = {
    totalCalls: 0,
    editCalls: 0,
    editErrors: 0,
    rateLimitRetries: 0,
    subagentSpawns: 0,
  };

  // The reader ALWAYS emits every counter it knows about; the artifact-facing
  // ToolMetrics keeps subagentSpawns optional only for older on-disk rows.
  const metrics = { ...empty, subagentSpawns: 0 };
  for (const event of await readSessionLogEvents(opts)) {
    const type = event['type'];
    if (type === 'tool_call_end') {
      metrics.totalCalls++;
      const name =
        typeof event['name'] === 'string' ? event['name'].toLowerCase().replace(/-/g, '_') : '';
      if (EDIT_TOOLS.has(name)) {
        metrics.editCalls++;
        if (event['ok'] === false) metrics.editErrors++;
      }
      // Only ADMITTED spawns count: a spawn_subagent call that ended in an
      // error (unknown role, budget refusal) spawned nothing, mirroring how
      // delegate_started is only emitted after the worker spawn resolves.
      if (name === 'spawn_subagent' && event['ok'] !== false) metrics.subagentSpawns++;
    } else if (type === 'delegate_started') {
      metrics.subagentSpawns++;
    } else if (
      (type === 'provider_retry' || type === 'provider_error') &&
      event['status'] === 429
    ) {
      metrics.rateLimitRetries++;
    }
  }
  return metrics;
}

/**
 * Sum `llm_response.usage` across the leader transcript and every subagent /
 * companion transcript under `<session>/subagents/`. Model-free and
 * crash-tolerant: a run killed mid-flight still reports the requests it made.
 */
export async function readTokenMetrics(opts: {
  homeDir: string;
  workdir: string;
}): Promise<TokenMetrics> {
  const leaderPath = await leaderTranscriptPath(opts);
  const leader = emptyUsage();
  const subagents = emptyUsage();
  if (leaderPath) {
    addUsage(leader, await readJsonlEvents(leaderPath));
    const subDir = path.join(
      path.dirname(leaderPath),
      path.basename(leaderPath, '.jsonl'),
      'subagents',
    );
    for (const file of await subagentTranscripts(subDir)) {
      addUsage(subagents, await readJsonlEvents(file));
    }
  }
  const subagentTotal = usageTotal(subagents);
  return {
    input: leader.input + subagents.input,
    cacheRead: leader.cacheRead + subagents.cacheRead,
    cacheWrite: leader.cacheWrite + subagents.cacheWrite,
    output: leader.output + subagents.output,
    requests: leader.requests + subagents.requests,
    subagentTotal,
    total: usageTotal(leader) + subagentTotal,
  };
}

interface UsageSum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  requests: number;
}

function emptyUsage(): UsageSum {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
}

function usageTotal(u: UsageSum): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

function addUsage(sum: UsageSum, events: SessionLogEvent[]): void {
  for (const event of events) {
    if (event['type'] !== 'llm_response') continue;
    const usage = event['usage'];
    if (!isRecord(usage)) continue;
    sum.input += count(usage['input']);
    sum.cacheRead += count(usage['cacheRead']);
    sum.cacheWrite += count(usage['cacheWrite']);
    sum.output += count(usage['output']);
    sum.requests++;
  }
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Subagent transcripts live date-sharded under the leader's `subagents/` dir.
 * `transcripts/` holds a message-only mirror of the same runs (no usage) and
 * is skipped so nothing is counted twice.
 */
async function subagentTranscripts(dir: string, depth = 0): Promise<string[]> {
  /* v8 ignore next -- guard against a pathological nesting; real trees are 2 deep. */
  if (depth > 4) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'transcripts') continue;
      files.push(...(await subagentTranscripts(full, depth + 1)));
    } else if (entry.isFile() && isSessionTranscriptName(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function leaderTranscriptPath(opts: {
  homeDir: string;
  workdir: string;
}): Promise<string | undefined> {
  try {
    const sessionsDir = resolveWstackPaths({
      projectRoot: opts.workdir,
      globalRoot: opts.homeDir,
    }).projectSessions;
    return await newestJsonl(sessionsDir);
  } catch {
    /* v8 ignore next -- resolveWstackPaths is pure and newestJsonl swallows its own fs errors; this outer catch is defensive. */
    return undefined;
  }
}

async function readJsonlEvents(file: string): Promise<SessionLogEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: SessionLogEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Tolerate partial/corrupt trailing lines from a hard-killed subprocess.
    }
  }
  return events;
}

/**
 * Read the current run's session events without interpreting them. The helper
 * deliberately shares the same missing/corrupt-log behaviour as
 * {@link readToolMetrics}: a crashed run yields an empty array rather than
 * losing the entire benchmark row.
 */
export async function readSessionLogEvents(opts: {
  homeDir: string;
  workdir: string;
}): Promise<SessionLogEvent[]> {
  const jsonlPath = await leaderTranscriptPath(opts);
  return jsonlPath ? readJsonlEvents(jsonlPath) : [];
}

/**
 * Session-store JSONLs that share the sessions directory but are NOT
 * transcripts: the store-level `_index.jsonl` / `_mailbox.jsonl` and the
 * per-session sidecars (`sess.replay.jsonl`, `sess.audit.jsonl`, legacy
 * `sess.annotations.jsonl`). Mirrors core's `isSessionTranscriptFileName`
 * (`core/src/utils/session-scoped-path.ts`) without importing it — this
 * reader deliberately stays dependency-light.
 */
const STORE_SIDECAR_JSONL_NAMES = new Set(['_index.jsonl', '_mailbox.jsonl']);
const SESSION_SIDECAR_JSONL_SUFFIXES = ['.replay.jsonl', '.audit.jsonl', '.annotations.jsonl'];

function isSessionTranscriptName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.jsonl')) return false;
  if (STORE_SIDECAR_JSONL_NAMES.has(lower)) return false;
  return !SESSION_SIDECAR_JSONL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Newest session transcript `*.jsonl` in the sessions directory, or undefined
 * if none. Store sidecars (`_index.jsonl`, `.replay.jsonl`, …) are NOT
 * candidates: the store appends its index row at session close — after the
 * final transcript flush — so an unfiltered newest-file scan reads index rows
 * instead of session events and every tool metric reports zero.
 *
 * WrongStack session ids are date-sharded in modern builds:
 *
 *   sessions/2026-06-11/sess_<id>.jsonl
 *
 * Legacy sessions may still live flat at `sessions/<id>.jsonl`, so scan both
 * the root and one shard level. Keep this local to bench so the metric reader
 * stays dependency-light and tolerant of incomplete/crashed runs.
 */
async function newestJsonl(dir: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let newest: { path: string; mtime: number } | undefined;
  const consider = async (full: string) => {
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) return;
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { path: full, mtime: stat.mtimeMs };
      }
    } catch {
      // skip unreadable entry
    }
  };

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isSessionTranscriptName(entry.name)) {
      await consider(full);
      continue;
    }
    if (!entry.isDirectory()) continue;

    let nested: Dirent[];
    try {
      nested = await fs.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (!isSessionTranscriptName(child.name)) continue;
      await consider(path.join(full, child.name));
    }
  }
  return newest?.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
