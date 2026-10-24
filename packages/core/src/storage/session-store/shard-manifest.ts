import * as fsp from 'node:fs/promises';
import type { SessionSummary } from '@wrongstack/contracts/types/session';
import { atomicWrite } from '../../utils/atomic-write.js';
import { compareSessionSummaries } from '../session-summary.js';
import { mapWithConcurrency } from '../storage-concurrency.js';
import type { DirectorySummaryCandidate, SessionFileRef, ShardManifestEntry } from './types.js';

export interface ReadOrBuildShardManifestOptions {
  shardKey: string;
  manifestPath: string;
  concurrency: number;
  collectSessionFilesInShard(shardKey: string): Promise<SessionFileRef[]>;
  /** Strict: rejects when the manifest exists but cannot be read. */
  readSummaryManifest(id: string): Promise<SessionSummary | null>;
  summaryHeaderFor(ref: SessionFileRef): Promise<SessionSummary | null>;
  summaryFor(id: string): Promise<SessionSummary>;
}

export async function readOrBuildShardManifestEntry(
  opts: ReadOrBuildShardManifestOptions,
): Promise<ShardManifestEntry & { transient?: true }> {
  try {
    const raw = await fsp.readFile(opts.manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as ShardManifestEntry;
    return {
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
    };
  } catch {
    // build below
  }

  const refs = await opts.collectSessionFilesInShard(opts.shardKey);
  // A session whose manifest is unreadable right now is listed from its journal
  // header, which has no rename; such an entry serves this listing only and is
  // never persisted or cached.
  let transient = false;
  const candidates = await mapWithConcurrency(
    refs,
    opts.concurrency,
    async (ref): Promise<DirectorySummaryCandidate | null> => {
      let manifest: SessionSummary | null;
      try {
        manifest = await opts.readSummaryManifest(ref.id);
      } catch {
        transient = true;
        const header = await opts.summaryHeaderFor(ref);
        return header ? { summary: header, needsBackfill: false } : null;
      }
      if (manifest) return { summary: manifest, needsBackfill: false };
      const summary = await opts.summaryHeaderFor(ref);
      if (!summary) return null;
      const hydrated = await opts.summaryFor(summary.id).catch(() => summary);
      return { summary: hydrated, needsBackfill: false };
    },
  );
  const summaries = candidates
    .filter((candidate): candidate is DirectorySummaryCandidate => candidate !== null)
    .map((candidate) => candidate.summary);
  summaries.sort(compareSessionSummaries);
  const entry: ShardManifestEntry = { summaries, ids: summaries.map((summary) => summary.id) };
  if (transient) return { ...entry, transient: true };
  await atomicWrite(opts.manifestPath, JSON.stringify(entry), { mode: 0o600 }).catch(
    () => undefined,
  );
  return entry;
}
