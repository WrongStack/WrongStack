import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { shouldSkipSessionDirectoryEntry } from '../storage/session-store/directory-scan.js';
import { totalUsageTokens } from '../types/provider.js';
import type { SessionEvent, SessionSummary } from '../types/session.js';
import { isSessionTranscriptFileName } from '../utils/session-scoped-path.js';
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
    if (
      event.type === 'message_appended' &&
      (event.message.role === 'user' || event.message.role === 'assistant')
    )
      messageCount++;
    if (event.type === 'llm_response') {
      iterationCount++;
      tokenTotal += totalUsageTokens(event.usage);
      // session_start pins the model the session OPENED with; a mid-session
      // switch or fallback rotation only shows up on the response that used
      // it. Last writer wins, matching the live tracker and the disk-rebuild
      // summary builder so all three agree on one row.
      if (event.model) routedModel = event.model;
      if (event.provider) routedProvider = event.provider;
    }
    if (event.type === 'tool_call_end') toolCallCount++;
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
  const transcripts = walkSessionFiles(sessionsDir, '.jsonl').filter((file) =>
    isSessionTranscriptFileName(path.basename(file)),
  );
  const ids = new Set<string>();
  for (const file of [...summaries, ...transcripts]) {
    const relative = path.relative(sessionsDir, file).replaceAll('\\', '/');
    ids.add(relative.replace(/\.summary\.json$|\.jsonl$/, ''));
  }
  let indexed = 0;
  let damaged = 0;
  transactionFn(() => {
    db.prepare('DELETE FROM sessions').run();
    for (const id of ids) {
      try {
        const summaryFile = containedPathFn(`${id}.summary.json`);
        const summary = fs.existsSync(summaryFile)
          ? parseJson<SessionSummary>(fs.readFileSync(summaryFile, 'utf8'))
          : summarizeTranscriptFile(containedPathFn(`${id}.jsonl`), id);
        if (!summary || summary.id !== id) throw new Error('summary identity mismatch');
        const transcript = containedPathFn(`${id}.jsonl`);
        const stat = fs.existsSync(transcript) ? fs.statSync(transcript) : undefined;
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,transcript_size,transcript_mtime_ms,summary_revision,indexed_at,damaged) VALUES (?,?,?,?,?,?,?,?,0)',
        ).run(
          id,
          `${id}.jsonl`,
          `${id}.summary.json`,
          JSON.stringify(summary),
          stat?.size ?? 0,
          stat?.mtimeMs ?? 0,
          1,
          now,
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
      "INSERT INTO catalog_meta(key,value) VALUES ('last_reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(new Date().toISOString());
    bumpGenerationFn();
  });
  return { indexed, damaged };
}
