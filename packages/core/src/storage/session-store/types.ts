import type { EventBus } from '../event-bus-port.js';
import type { Logger } from '../../types/logger.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionData, SessionEvent, SessionSummary } from '../../types/session.js';

export interface SessionStoreOptions {
  dir: string;
  /**
   * Active project root used to revalidate persisted file-observation hashes
   * during resume. Omit for stores that only inspect/archive transcripts.
   */
  projectRoot?: string | undefined;
  /** Optional EventBus for emitting session diagnostics. */
  events?: EventBus | undefined;
  /**
   * Optional scrubber override. A DefaultSecretScrubber is always installed
   * so legacy plaintext is sanitized before caching/projection and new writes
   * retain write-time protection.
   */
  secretScrubber?: SecretScrubber | undefined;
  /**
   * Optional guard consulted by {@link DefaultSessionStore.delete} before
   * removing a session. Reports whether the session is currently in use by
   * any live process (e.g. it is the active session of another terminal, TUI,
   * or WebUI in this project). Production hosts wire this to the cross-process
   * SessionRegistry; there is deliberately no project-wide active-session lock.
   * Resolves to a human-readable reason when in use, or `null` when safe.
   */
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined;
  /** Logger for structured warnings. Falls back to console.warn when omitted. */
  logger?: Logger | undefined;
  /**
   * Optional callback invoked synchronously after each event is scrubbed,
   * observed, and before it enters the write buffer. The event has been
   * scrubbed (PII removed) and observed (counters updated) but NOT yet
   * persisted to disk. Used by the HQ telemetry bridge to stream events
   * without reading them back from the JSONL file.
   */
  onAppend?: ((event: SessionEvent) => void) | undefined;
  /** Batch variant of {@link onAppend}. Called once per batch with
   * all scrubbed events after all have been observed. */
  onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  storage?:
    | {
        hotKeepSessions?: number | undefined;
        archiveAfterDays?: number | undefined;
        autoArchive?: boolean | undefined;
        includeSubagents?: boolean | undefined;
      }
    | undefined;
}

/**
 * Cache entry for load() â€” stores the parsed SessionData along with the
 * file's mtimeMs and size at the time of loading. On subsequent calls,
 * if the file's mtimeMs+size match, we return the cached data without
 * re-reading or re-parsing the JSONL.
 */
export interface LoadCacheEntry {
  mtimeMs: number;
  /** Source journal size — the freshness key, paired with `mtimeMs`. */
  size: number;
  data: SessionData;
  /**
   * Estimated heap this entry occupies, and what it is charged against the
   * cache budget. Distinct from `size`: a journal is mostly superseded
   * snapshots and evicted events, so the file dwarfs what survives into
   * `data`. Optional for entries written before the distinction existed.
   */
  bytes?: number | undefined;
}

export interface IndexCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  birthtimeMs: number;
  summaries: SessionSummary[];
  byId: Map<string, SessionSummary>;
  deleted: Set<string>;
}

export interface SessionFileRef {
  id: string;
  filePath: string;
}

export interface DirectorySummaryCandidate {
  summary: SessionSummary;
  needsBackfill: boolean;
}

export interface ShardManifestEntry {
  summaries: SessionSummary[];
  ids: string[];
}
