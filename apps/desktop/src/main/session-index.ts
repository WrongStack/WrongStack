/**
 * The sessions a project has, for the desktop sidebar.
 *
 * ## Why the sidecars and not the catalog
 *
 * `SessionCatalogStore` indexes exactly this data into SQLite and would answer
 * in one query, but it is not ours to open: the project daemon owns that
 * database (one writer per project), and its constructor opens read-write and
 * runs schema initialisation. A second opener in the desktop main process
 * would violate that ownership.
 *
 * Going through `SessionCatalogProjectClient` instead would mean a running
 * daemon — and the sidebar's whole point is to list sessions for projects that
 * are NOT running, so there is no daemon to ask. The `.summary.json` sidecars
 * are written next to each transcript by `file-session-writer.ts` and carry
 * everything a sidebar row needs, so reading them directly is both the cheapest
 * correct source and the only one available for a stopped project.
 *
 * ## Cost
 *
 * Sessions are stored in date shards (`sessions/2026-09-08/<id>.summary.json`).
 * Shard names sort chronologically as strings, so walking them newest-first and
 * stopping at `limit` reads a couple of directories and `limit` small files
 * (~900 bytes each) rather than scanning a project's whole history. Results are
 * memoised for a few seconds so an expanded project in the sidebar does not
 * re-read on every render.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { projectSlug, wstackGlobalRoot } from '@wrongstack/core/utils';
import type { DesktopSessionEntry } from '../shared/types.js';

/** Date-shard directory name, e.g. `2026-09-08`. */
const SHARD_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_SUFFIX = '.summary.json';

/** Default rows per project. The sidebar shows a project's recent work, not its archive. */
export const DEFAULT_SESSION_LIMIT = 25;

/**
 * How long a memoised result is served before re-reading.
 *
 * Deliberately a TTL and not a directory-mtime key. A new session written into
 * an EXISTING date shard changes `sessions/<date>/` but leaves `sessions/`
 * untouched, so an mtime key would serve a stale list for the rest of the day —
 * the sidebar would silently stop showing new sessions. The cache exists only
 * to keep an expanded project from re-reading on every render; bounding its
 * staleness is what makes it safe.
 */
const CACHE_TTL_MS = 4_000;

interface CacheEntry {
  readAt: number;
  limit: number;
  sessions: DesktopSessionEntry[];
}

const cache = new Map<string, CacheEntry>();

/** The per-project store directory for a project root. */
export function projectStoreDir(projectRoot: string): string {
  return path.join(wstackGlobalRoot(), 'projects', projectSlug(path.resolve(projectRoot)));
}

/**
 * Shape one `.summary.json` into a sidebar row.
 *
 * Returns null for anything that is not a usable summary: the sidecar is
 * written after the fact, so a crashed session can leave a truncated or absent
 * file, and a row with no id is not addressable.
 */
function toEntry(raw: unknown, fallbackId: string, mtimeMs: number): DesktopSessionEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id !== '' ? r.id : fallbackId;
  if (!id) return null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const startedAt = typeof r.startedAt === 'string' ? r.startedAt : new Date(mtimeMs).toISOString();
  const lastActivityAt =
    typeof r.lastActivityAt === 'string'
      ? r.lastActivityAt
      : typeof r.endedAt === 'string'
        ? r.endedAt
        : startedAt;
  return {
    id,
    // A session that never got a first user message has no title. Showing the
    // id is better than an empty row the user cannot identify.
    title: title || id.split('/').pop() || id,
    startedAt,
    lastActivityAt,
    ...(typeof r.messageCount === 'number' ? { messageCount: r.messageCount } : {}),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    ...(typeof r.provider === 'string' ? { provider: r.provider } : {}),
  };
}

/**
 * Recent sessions for a project root, newest activity first.
 *
 * Never throws: a project with no store directory yet, an unreadable shard, or
 * a corrupt sidecar all degrade to fewer rows. The sidebar must render either
 * way — a missing session list is not a reason to fail a project row.
 */
export async function listProjectSessions(
  projectRoot: string,
  options: { limit?: number } = {},
): Promise<DesktopSessionEntry[]> {
  const limit = options.limit ?? DEFAULT_SESSION_LIMIT;
  if (limit <= 0) return [];
  const sessionsDir = path.join(projectStoreDir(projectRoot), 'sessions');

  const dirStat = await fs.stat(sessionsDir).catch(() => null);
  if (!dirStat?.isDirectory()) return [];

  const cached = cache.get(sessionsDir);
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS && cached.limit >= limit) {
    return cached.sessions.slice(0, limit);
  }

  let shards: string[];
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    shards = entries
      .filter((entry) => entry.isDirectory() && SHARD_RE.test(entry.name))
      .map((entry) => entry.name)
      // Shard names are ISO dates, so a plain string sort is chronological.
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }

  const sessions: DesktopSessionEntry[] = [];
  for (const shard of shards) {
    if (sessions.length >= limit) break;
    const shardDir = path.join(sessionsDir, shard);
    let files: string[];
    try {
      files = (await fs.readdir(shardDir)).filter((name) => name.endsWith(SUMMARY_SUFFIX));
    } catch {
      continue;
    }
    // Session ids are ULIDs, which sort by creation time — newest last, so
    // reverse to read the most recent of the day first.
    files.sort((a, b) => b.localeCompare(a));
    for (const file of files) {
      if (sessions.length >= limit) break;
      const full = path.join(shardDir, file);
      let text: string;
      let mtimeMs: number;
      try {
        const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
        text = content;
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A summary written during a crash can be truncated. Skip it rather
        // than dropping the whole shard.
        continue;
      }
      const fallbackId = `${shard}/${file.slice(0, -SUMMARY_SUFFIX.length)}`;
      const entry = toEntry(parsed, fallbackId, mtimeMs);
      if (entry) sessions.push(entry);
    }
  }

  sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  cache.set(sessionsDir, { readAt: Date.now(), limit, sessions });
  return sessions;
}

/** Drop memoised results. Exposed for tests and for an explicit refresh. */
export function clearSessionIndexCache(): void {
  cache.clear();
}
