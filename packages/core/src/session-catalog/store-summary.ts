import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import { isCanonicalTranscriptRelativePath } from '../storage/session-store/transcript-location.js';
import type { SessionSummary } from '../types/session.js';
import type { CatalogSessionRecord } from './protocol.js';
import { assertId, type CatalogRow, parseJson } from './store-schema.js';

export function resolveContainedPath(sessionsDir: string, relative: string): string {
  assertId(
    relative
      .replace(/\.jsonl\.gz$/, '')
      .replace(/\.(jsonl|summary\.json|plan\.json|tasks\.json|todos\.json)$/, ''),
    'session path',
  );
  const root = path.resolve(sessionsDir);
  const candidate = path.resolve(root, relative);
  const prefix = `${root}${path.sep}`;
  if (
    candidate !== root &&
    !(process.platform === 'win32'
      ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
      : candidate.startsWith(prefix))
  ) {
    throw new TypeError('Session path escapes sessions directory');
  }
  return candidate;
}

export function toCatalogRecord(row: CatalogRow): CatalogSessionRecord {
  const storageState = row.storage_state === 'cold' ? 'cold' : 'hot';
  return {
    ...parseJson<SessionSummary>(row.summary_json),
    transcriptRelativePath: row.transcript_relative_path,
    summaryRelativePath: row.summary_relative_path,
    transcriptSize: row.transcript_size,
    transcriptMtimeMs: row.transcript_mtime_ms,
    summaryRevision: row.summary_revision,
    indexedAt: row.indexed_at,
    damaged: row.damaged !== 0,
    storageState,
    ...(row.codec === 'gzip' ? { codec: 'gzip' as const } : {}),
    uncompressedSize: row.uncompressed_size ?? 0,
    compressedSize: row.compressed_size ?? 0,
    ...(row.content_sha256 ? { contentSha256: row.content_sha256 } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

export function executeUpsertSummary(
  db: DatabaseSync,
  sessionsDir: string,
  scrubber: DefaultSecretScrubber,
  summary: SessionSummary,
  transcriptRelativePath = `${summary.id}.jsonl`,
  summaryRelativePath = `${summary.id}.summary.json`,
  storage?: {
    storageState?: 'hot' | 'cold' | undefined;
    codec?: 'gzip' | undefined;
    uncompressedSize?: number | undefined;
    compressedSize?: number | undefined;
    contentSha256?: string | undefined;
    archivedAt?: string | null | undefined;
  },
  bumpGeneration?: () => number,
): CatalogSessionRecord {
  assertId(summary.id);
  summary = scrubber.scrubObject(summary);
  const normalizedTranscript = transcriptRelativePath.replaceAll('\\', '/');
  const normalizedSummary = summaryRelativePath.replaceAll('\\', '/');
  if (
    !isCanonicalTranscriptRelativePath(summary.id, normalizedTranscript) ||
    normalizedSummary !== `${summary.id}.summary.json`
  ) {
    throw new TypeError('Session catalog paths must match the canonical session identity');
  }
  transcriptRelativePath = normalizedTranscript;
  summaryRelativePath = normalizedSummary;
  const transcript = resolveContainedPath(sessionsDir, transcriptRelativePath);
  const stat = fs.existsSync(transcript) ? fs.statSync(transcript) : undefined;
  const now = new Date().toISOString();
  const storageState =
    storage?.storageState ?? (transcriptRelativePath.endsWith('.jsonl.gz') ? 'cold' : 'hot');
  const codec = storage?.codec ?? (storageState === 'cold' ? 'gzip' : undefined);
  const uncompressedSize =
    storage?.uncompressedSize ?? (storageState === 'hot' ? (stat?.size ?? 0) : 0);
  const compressedSize =
    storage?.compressedSize ?? (storageState === 'cold' ? (stat?.size ?? 0) : 0);
  const contentSha256 = storage?.contentSha256;
  const archivedAt =
    storage?.archivedAt === null
      ? null
      : (storage?.archivedAt ?? (storageState === 'cold' ? now : null));

  const prior = db
    .prepare('SELECT summary_revision FROM sessions WHERE session_id=?')
    .get(summary.id) as { summary_revision: number } | undefined;
  const revision = (prior?.summary_revision ?? 0) + 1;
  db.prepare(`INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,transcript_size,transcript_mtime_ms,summary_revision,indexed_at,damaged,storage_state,codec,uncompressed_size,compressed_size,content_sha256,archived_at)
  VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET transcript_relative_path=excluded.transcript_relative_path,summary_relative_path=excluded.summary_relative_path,summary_json=excluded.summary_json,transcript_size=excluded.transcript_size,transcript_mtime_ms=excluded.transcript_mtime_ms,summary_revision=excluded.summary_revision,indexed_at=excluded.indexed_at,damaged=0,storage_state=excluded.storage_state,codec=excluded.codec,uncompressed_size=excluded.uncompressed_size,compressed_size=excluded.compressed_size,content_sha256=excluded.content_sha256,archived_at=excluded.archived_at`).run(
    summary.id,
    transcriptRelativePath,
    summaryRelativePath,
    JSON.stringify(summary),
    stat?.size ?? 0,
    stat?.mtimeMs ?? 0,
    revision,
    now,
    storageState,
    codec ?? null,
    uncompressedSize,
    compressedSize,
    contentSha256 ?? null,
    archivedAt,
  );
  bumpGeneration?.();
  return {
    ...summary,
    transcriptRelativePath,
    summaryRelativePath,
    transcriptSize: stat?.size ?? 0,
    transcriptMtimeMs: stat?.mtimeMs ?? 0,
    summaryRevision: revision,
    indexedAt: now,
    damaged: false,
    storageState,
    ...(codec ? { codec } : {}),
    uncompressedSize,
    compressedSize,
    ...(contentSha256 ? { contentSha256 } : {}),
    ...(archivedAt ? { archivedAt } : {}),
  };
}
