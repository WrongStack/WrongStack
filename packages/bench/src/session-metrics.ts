import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core';
import type { ToolMetrics } from './types.js';

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
  };

  let jsonlPath: string | undefined;
  try {
    const sessionsDir = resolveWstackPaths({
      projectRoot: opts.workdir,
      globalRoot: opts.homeDir,
    }).projectSessions;
    jsonlPath = await newestJsonl(sessionsDir);
  } catch {
    /* v8 ignore next -- resolveWstackPaths is pure and newestJsonl swallows its own fs errors; this outer catch is defensive. */
    return empty;
  }
  if (!jsonlPath) return empty;

  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, 'utf8');
  } catch {
    return empty;
  }

  const metrics = { ...empty };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // tolerate partial/corrupt trailing lines
    }
    const type = event['type'];
    if (type === 'tool_call_end') {
      metrics.totalCalls++;
      const name = typeof event['name'] === 'string' ? event['name'].toLowerCase() : '';
      if (EDIT_TOOLS.has(name)) {
        metrics.editCalls++;
        if (event['ok'] === false) metrics.editErrors++;
      }
    } else if (type === 'provider_retry' || type === 'provider_error') {
      metrics.rateLimitRetries++;
    }
  }
  return metrics;
}

/**
 * Newest `*.jsonl` in the sessions directory, or undefined if none.
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
  let entries: import('node:fs').Dirent[];
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
    if (entry.name.endsWith('.jsonl')) {
      await consider(full);
      continue;
    }
    if (!entry.isDirectory()) continue;

    let nested: import('node:fs').Dirent[];
    try {
      nested = await fs.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (!child.name.endsWith('.jsonl')) continue;
      await consider(path.join(full, child.name));
    }
  }
  return newest?.path;
}
