import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import { atomicWrite, ensureDir, withFileLock } from '../utils/atomic-write.js';

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
   * Every entry this instance has loaded or saved. Two TUIs on one project
   * share the file and each saves its whole in-memory list, so anything on
   * disk that this instance never saw was added by another process and must
   * be merged in, not overwritten.
   */
  private readonly known = new Set<string>();
  /** The list this instance last loaded or saved — its "new" entries are the rest. */
  private lastSaved = new Set<string>();

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
    const entries = await this.readEntries();
    for (const entry of entries) this.known.add(entry);
    this.lastSaved = new Set(entries);
    return entries;
  }

  private async readEntries(strict = false): Promise<string[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      // save() merges what other sessions wrote from this read: an unreadable
      // file taken as [] was written back without their prompts.
      if (strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return [];
    }
    // A Windows editor saves the file with a UTF-8 BOM, which JSON.parse
    // rejects; the entries behind it are real history, not corruption.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    // A blank file holds nothing to lose; refusing it would lock the store out.
    if (body.trim() === '') return [];
    try {
      const raw: InputHistoryFile = JSON.parse(body);
      if (
        raw &&
        typeof raw === 'object' &&
        Array.isArray(raw.entries) &&
        raw.entries.every((e) => typeof e === 'string')
      ) {
        return raw.entries.slice(0, this.maxEntries);
      }
      if (strict) throw new Error(`unsupported input history file schema in ${this.file}`);
    } catch (err) {
      // save() merges foreign entries from this read: taking an unparseable
      // file as [] in strict mode wrote those prompts away (F468).
      if (strict) throw err;
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
    await ensureDir(path.dirname(this.file));
    await withFileLock(this.file, async () => {
      const foreign = (await this.readEntries(true)).filter(
        (entry) => !this.known.has(entry) && !entries.includes(entry),
      );
      // Newest first: this instance's new prompts, then the other instance's,
      // then the rest of this instance's list.
      const fresh = entries.filter((entry) => !this.lastSaved.has(entry));
      const merged = [...new Set([...fresh, ...foreign, ...entries])];
      const payload: InputHistoryFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: this.scrubAndFilter(merged),
      };
      await atomicWrite(this.file, JSON.stringify(payload, null, 2));
      for (const entry of entries) this.known.add(entry);
      this.lastSaved = new Set(entries);
    });
  }

  /** Truncate the file to an empty entry list (used by /clear). */
  async clear(): Promise<void> {
    await ensureDir(path.dirname(this.file));
    await withFileLock(this.file, async () => {
      const payload: InputHistoryFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: [],
      };
      await atomicWrite(this.file, JSON.stringify(payload, null, 2));
    });
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
