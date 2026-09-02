import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';

/**
 * On-disk shape of the per-project TUI input history file. Newest entry
 * first. `version` is forward-compat — a future schema bump can migrate.
 */
interface InputHistoryFile {
  version: 1;
  updatedAt: string;
  entries: string[];
}

export const INPUT_HISTORY_DEFAULT_MAX = 100;

/**
 * Per-project TUI prompt input history.
 *
 * Backed by a single JSON file at `~/.wrongstack/projects/<slug>/input-
 * history.json`. Entries are newest-first, capped at `maxEntries`. Before
 * any entry is written to disk it is passed through a `SecretScrubber` and
 * dropped if it still contains a redacted marker — leaking a pasted API
 * key into a history file would be a real incident, so the scrubber is
 * mandatory, not optional.
 *
 * The store is intentionally small and synchronous-ish (load once at TUI
 * boot, save debounced on change). It mirrors PromptUsageStore's shape so
 * the two read as a family.
 */
export class InputHistoryStore {
  /**
   * @param file Absolute path to the per-project input-history.json.
   * @param scrubber SecretScrubber used to filter secrets before write.
   * @param maxEntries Cap on the number of entries persisted. Default 100.
   */
  constructor(
    private readonly file: string,
    private readonly scrubber: SecretScrubber,
    private readonly maxEntries: number = INPUT_HISTORY_DEFAULT_MAX,
  ) {}

  /**
   * Load the persisted entries. Missing or corrupt file → empty list
   * (never throws — history is best-effort).
   */
  async load(): Promise<string[]> {
    try {
      const raw: InputHistoryFile = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (
        raw &&
        typeof raw === 'object' &&
        Array.isArray(raw.entries) &&
        raw.entries.every((e) => typeof e === 'string')
      ) {
        return raw.entries.slice(0, this.maxEntries);
      }
    } catch {
      // missing or corrupt → empty
    }
    return [];
  }

  /**
   * Persist `entries` to disk after scrubbing each one. Entries that still
   * contain a redaction marker AFTER scrubbing are dropped — a half-scrubbed
   * prompt like "export API_KEY=***REDACTED***" is useless as history and
   * keeping it risks confusing the agent. Dedup is the caller's job (the
   * reducer already dedups); this method only scrubs, caps, and writes.
   */
  async save(entries: string[]): Promise<void> {
    const cleaned = this.scrubAndFilter(entries);
    await ensureDir(path.dirname(this.file));
    const payload: InputHistoryFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: cleaned,
    };
    await atomicWrite(this.file, JSON.stringify(payload, null, 2));
  }

  /** Truncate the file to an empty entry list (used by /clear). */
  async clear(): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const payload: InputHistoryFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    };
    await atomicWrite(this.file, JSON.stringify(payload, null, 2));
  }

  /**
   * Run each entry through the scrubber and drop any that still contain a
   * redaction marker. Internal so the test suite can pin the policy.
   */
  private scrubAndFilter(entries: string[]): string[] {
    const out: string[] = [];
    for (const entry of entries) {
      const scrubbed = this.scrubber.scrub(entry);
      if (this.looksRedacted(scrubbed)) continue;
      out.push(scrubbed);
    }
    return out.slice(0, this.maxEntries);
  }

  /**
   * Heuristic: did the scrubber actually redact anything? DefaultSecretScrubber
   * replaces matches with "[REDACTED:<type>]" (and legacy mocks with
   * "***REDACTED***"), so a residual marker means a secret was detected.
   */
  private looksRedacted(text: string): boolean {
    return text.includes('***REDACTED***') || /\[REDACTED:[a-zA-Z0-9_-]+\]/.test(text);
  }
}
