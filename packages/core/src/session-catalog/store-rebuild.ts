import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { totalUsageTokens } from '@wrongstack/contracts/types/provider';
import type { SessionEvent, SessionSummary } from '@wrongstack/contracts/types/session';
import { shouldSkipSessionDirectoryEntry } from '../storage/session-store/directory-scan.js';
import {
  isSessionTranscriptFileName,
  stripSessionTranscriptExtension,
} from '../utils/session-scoped-path.js';
import { parseJson } from './store-schema.js';

/**
 * Collect the transcript/summary files this catalog indexes.
 *
 * Skips exactly what `DefaultSessionStore`'s own directory scan skips — see
 * `shouldSkipSessionDirectoryEntry`. The two disagreed: the store excluded
 * `subagents/` (and `shared/`, `attachments/`) from what counts as a session,
 * while this walk descended into them, so a full rebuild pushed subagent
 * transcripts into the table backing the user's session list. On a real project
 * that is 3,156 worker transcripts against 170 actual sessions; the five
 * subagent rows found in a live catalog were this leak already in progress.
 *
 * Subagent transcripts are not unindexed — each director run maintains its own
 * `_index.jsonl` beside them. They just are not user-resumable sessions.
 */
export function walkSessionFiles(root: string, suffix: string): string[] {
  const result: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === '_cas' || entry.name === '_trash') continue;
        if (shouldSkipSessionDirectoryEntry(entry.name)) continue;
        visit(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(suffix))
        result.push(path.join(dir, entry.name));
    }
  };
  visit(root);
  return result;
}

export function summarizeTranscriptFile(transcriptFilePath: string, id: string): SessionSummary {
  const lines = fs.readFileSync(transcriptFilePath, 'utf8').split(/\r?\n/);
  let start: Extract<SessionEvent, { type: 'session_start' }> | undefined;
  let endedAt: string | undefined;
  let lastActivityAt: string | undefined;
  let messageCount = 0;
  let iterationCount = 0;
  let toolCallCount = 0;
  let compactionCount = 0;
  let tokenTotal = 0;
  let routedModel: string | undefined;
  let routedProvider: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    let event: SessionEvent;
    try {
      event = parseJson<SessionEvent>(line);
    } catch {
      continue;
    }
    lastActivityAt = event.ts;
    if (event.type === 'session_start') start = event;
    if (event.type === 'session_end') endedAt = event.ts;
    // Counters mirror `summarizeSessionEventSequence` in
    // storage/session-store/summary-builder.ts exactly: the same transcript
    // must report the same counts whether the file-backed store scanned it or
    // the SQLite catalog rebuilt it. Legacy journals use user_input/
    // llm_response; modern journals use message_appended.
    if (event.type === 'user_input') messageCount++;
    if (event.type === 'message_appended' && event.version === 1 && event.message) messageCount++;
    if (event.type === 'llm_response') {
      messageCount++;
      tokenTotal += totalUsageTokens(event.usage);
      // session_start pins the model the session OPENED with; a mid-session
      // switch or fallback rotation only shows up on the response that used
      // it. Last writer wins, matching the live tracker and the disk-rebuild
      // summary builder so all three agree on one row.
      if (event.model) routedModel = event.model;
      if (event.provider) routedProvider = event.provider;
    }
    if (event.type === 'enhance_usage') tokenTotal += totalUsageTokens(event.usage);
    if (event.type === 'in_flight_start') iterationCount++;
    if (event.type === 'tool_call_start') toolCallCount++;
    if (event.type === 'compaction') compactionCount++;
  }
  if (!start) throw new Error('missing session_start');
  return {
    id,
    title: id,
    startedAt: start.ts,
    ...(endedAt ? { endedAt } : {}),
    model: routedModel ?? start.model,
    provider: routedProvider ?? start.provider,
    tokenTotal,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    messageCount,
    iterationCount,
    toolCallCount,
    compactionCount,
  };
}

export function rebuildCatalogIndex(
  db: DatabaseSync,
  sessionsDir: string,
  containedPathFn: (relative: string) => string,
  transactionFn: <T>(run: () => T) => T,
  bumpGenerationFn: () => number,
): { indexed: number; damaged: number } {
  const summaries = walkSessionFiles(sessionsDir, '.summary.json');
  const transcripts = [
    ...walkSessionFiles(sessionsDir, '.jsonl'),
    ...walkSessionFiles(sessionsDir, '.jsonl.gz'),
  ].filter((file) => isSessionTranscriptFileName(path.basename(file)));
  const ids = new Set<string>();
  for (const file of [...summaries, ...transcripts]) {
    const relative = path.relative(sessionsDir, file).replaceAll('\\', '/');
    ids.add(stripSessionTranscriptExtension(relative.replace(/\.summary\.json$/, '')));
  }
  let indexed = 0;
  let damaged = 0;
  transactionFn(() => {
    const priorStorage = new Map<
      string,
      {
        uncompressed_size: number;
        compressed_size: number;
        content_sha256: string | null;
        archived_at: string | null;
      }
    >();
    for (const row of db
      .prepare(
        'SELECT session_id, uncompressed_size, compressed_size, content_sha256, archived_at FROM sessions',
      )
      .all() as Array<{
      session_id: string;
      uncompressed_size: number;
      compressed_size: number;
      content_sha256: string | null;
      archived_at: string | null;
    }>) {
      priorStorage.set(row.session_id, row);
    }
    db.prepare('DELETE FROM sessions').run();
    for (const id of ids) {
      try {
        const summaryFile = containedPathFn(`${id}.summary.json`);
        const hot = containedPathFn(`${id}.jsonl`);
        const cold = containedPathFn(`${id}.jsonl.gz`);
        const hotExists = fs.existsSync(hot);
        const coldExists = fs.existsSync(cold);
        const transcript = hotExists ? hot : cold;
        const relative = hotExists ? `${id}.jsonl` : `${id}.jsonl.gz`;
        const storageState = hotExists ? 'hot' : 'cold';
        const summary = fs.existsSync(summaryFile)
          ? parseJson<SessionSummary>(fs.readFileSync(summaryFile, 'utf8'))
          : hotExists
            ? summarizeTranscriptFile(hot, id)
            : (() => {
                throw new Error('compressed transcript requires a summary sidecar');
              })();
        if (!summary || summary.id !== id) throw new Error('summary identity mismatch');
        const stat = transcript && (hotExists || coldExists) ? fs.statSync(transcript) : undefined;
        const now = new Date().toISOString();
        const prior = priorStorage.get(id);
        const uncompressedSize =
          storageState === 'hot'
            ? (stat?.size ?? 0)
            : (summary.uncompressedBytes ??
              (prior && prior.uncompressed_size > 0 ? prior.uncompressed_size : 0));
        const compressedSize =
          storageState === 'cold'
            ? (stat?.size ?? summary.compressedBytes ?? prior?.compressed_size ?? 0)
            : 0;
        const contentSha256 = storageState === 'cold' ? (prior?.content_sha256 ?? null) : null;
        const archivedAt =
          storageState === 'cold' ? (summary.archivedAt ?? prior?.archived_at ?? now) : null;
        db.prepare(
          'INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,transcript_size,transcript_mtime_ms,summary_revision,indexed_at,damaged,storage_state,codec,uncompressed_size,compressed_size,content_sha256,archived_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)',
        ).run(
          id,
          relative,
          `${id}.summary.json`,
          JSON.stringify(summary),
          stat?.size ?? 0,
          stat?.mtimeMs ?? 0,
          1,
          now,
          storageState,
          storageState === 'cold' ? 'gzip' : null,
          uncompressedSize,
          compressedSize,
          contentSha256,
          archivedAt,
        );
        indexed++;
      } catch {
        const now = new Date().toISOString();
        const fallback: SessionSummary = {
          id,
          title: id,
          startedAt: now,
          model: '',
          provider: '',
          tokenTotal: 0,
        };
        db.prepare(
          'INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,summary_revision,indexed_at,damaged) VALUES (?,?,?,?,1,?,1)',
        ).run(id, `${id}.jsonl`, `${id}.summary.json`, JSON.stringify(fallback), now);
        damaged++;
      }
    }
    db.prepare(
      'DELETE FROM session_agents WHERE session_id NOT IN (SELECT session_id FROM sessions)',
    ).run();
    db.prepare(
      'DELETE FROM session_agent_index WHERE session_id NOT IN (SELECT session_id FROM sessions)',
    ).run();
    db.prepare(
      "INSERT INTO catalog_meta(key,value) VALUES ('last_reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(new Date().toISOString());
    bumpGenerationFn();
  });
  return { indexed, damaged };
}
