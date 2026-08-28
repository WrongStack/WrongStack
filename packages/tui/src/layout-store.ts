/**
 * Layout store — per-session persistence of entry layout data.
 *
 * Stores a layout snapshot (entry id → row height / char count / term width)
 * in memory during the session and persists it to disk alongside the session
 * data so a resumed session can reconstruct the virtual scroll viewport
 * without mounting every entry just to discover its height.
 *
 * Threading: designed for single-threaded use in the TUI's React render
 * cycle. Disk writes use atomic-write (temp-file + rename) for crash safety.
 * Calls should be batched; writes are debounced (500ms idle after last set).
 */

import * as path from 'node:path';
import type { EntryLayout, LayoutSnapshot } from './layout-engine.js';
import { FALLBACK_ROWS, LAYOUT_VERSION } from './layout-engine.js';

// ── Constants ────────────────────────────────────────────────────────────

/** File name of the layout snapshot inside the session data directory. */
const LAYOUT_FILENAME = 'tui-layout.json';

/**
 * Debounce interval for disk writes (ms). Prevents a high-frequency burst
 * of layout updates (common on terminal resize) from hammering the disk.
 */
const DEBOUNCE_MS = 500;

// ── Types ────────────────────────────────────────────────────────────────

interface LayoutStoreOptions {
  /** Directory where the session's layout snapshot is stored. */
  sessionDataDir: string | undefined;
  /** When true, skip all disk I/O (for testing / no-session mode). */
  ephemeral?: boolean;
}

// ── LayoutStore ──────────────────────────────────────────────────────────

export class LayoutStore {
  /** In-memory map: entry id → layout data. */
  private readonly layouts = new Map<number, EntryLayout>();

  /** Current terminal width used for layout computations. */
  private currentTermWidth = 80;

  /** Session data directory path, or undefined for ephemeral mode. */
  private readonly sessionDataDir: string | undefined;

  /** When true, skip all disk I/O. */
  private readonly ephemeral: boolean;

  /** Debounce timer handle for pending disk writes. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending dirty flag — set when in-memory state diverges from disk. */
  private dirty = false;

  constructor(options: LayoutStoreOptions) {
    this.sessionDataDir = options.sessionDataDir;
    this.ephemeral = options.ephemeral ?? false;
  }

  // ── Terminal width ──

  /** Set the terminal width used for layout computation. */
  setTermWidth(width: number): void {
    this.currentTermWidth = Math.max(16, width);
  }

  /** Get the current terminal width. */
  get termWidth(): number {
    return this.currentTermWidth;
  }

  // ── Query ──

  /** Number of entries tracked. */
  get size(): number {
    return this.layouts.size;
  }

  /** Get the cached layout for an entry id, or undefined. */
  get(id: number): EntryLayout | undefined {
    return this.layouts.get(id);
  }

  /** Get the cached row height for an entry id. Returns fallback if unknown. */
  getRows(id: number): number {
    return this.layouts.get(id)?.rows ?? FALLBACK_ROWS;
  }

  /**
   * True when every entry id in the set has a measured (non-estimated) layout.
   */
  allMeasured(ids: Iterable<number>): boolean {
    for (const id of ids) {
      const layout = this.layouts.get(id);
      if (layout?.kind !== 'measured') return false;
    }
    return true;
  }

  // ── Mutations ──

  /**
   * Record or update the layout for an entry. Idempotent when both the
   * terminal width and row count are unchanged. Marks the store dirty and
   * schedules a debounced disk write.
   */
  set(id: number, layout: EntryLayout): void {
    const existing = this.layouts.get(id);
    if (
      existing &&
      existing.termWidth === layout.termWidth &&
      existing.rows === layout.rows &&
      existing.kind === 'measured' &&
      layout.kind === 'measured'
    ) {
      return; // no meaningful change
    }
    this.layouts.set(id, layout);
    this.dirty = true;
    this.scheduleFlush();
  }

  /**
   * Batch-set multiple layouts at once. More efficient than calling `set()`
   * in a loop because it only triggers one debounced flush.
   */
  setMany(entries: Iterable<EntryLayout>): void {
    let changed = false;
    for (const layout of entries) {
      const existing = this.layouts.get(layout.id);
      if (
        existing &&
        existing.termWidth === layout.termWidth &&
        existing.rows === layout.rows &&
        existing.kind === 'measured' &&
        layout.kind === 'measured'
      ) {
        continue;
      }
      this.layouts.set(layout.id, layout);
      changed = true;
    }
    if (changed) {
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  /**
   * Promote a layout from 'estimated' to 'measured' once the real component
   * has been mounted and its actual height is known.
   *
   * Also updates the stored `termWidth` to the current terminal width: after a
   * resize, entries are re-seeded with the new width as estimates, and the
   * post-render measurement pass needs to stamp the actual width so the store
   * is consistent. Without this, a subsequent render sees `stored.termWidth`
   * mismatch the current width and re-seeds estimates, discarding the
   * measurement and corrupting the virtual scroll viewport.
   */
  markMeasured(id: number, actualRows: number, termWidth = this.currentTermWidth): void {
    const existing = this.layouts.get(id);
    if (!existing) return;
    if (
      existing.kind === 'measured' &&
      existing.rows === actualRows &&
      existing.termWidth === termWidth
    ) {
      return;
    }

    this.layouts.set(id, {
      ...existing,
      // Zero rows is legal: hidden entries (reasoning display off) render
      // nothing, and persisting 1 here would reintroduce a phantom row on
      // every re-seed from the store.
      rows: Math.max(0, actualRows),
      kind: 'measured',
      termWidth,
    });
    this.dirty = true;
    this.scheduleFlush();
  }

  /**
   * Remove entries no longer in the active set (after history retention).
   */
  retain(entryIds: Set<number>): void {
    let changed = false;
    for (const id of this.layouts.keys()) {
      if (!entryIds.has(id)) {
        this.layouts.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  /** Reset all in-memory state (on /clear). */
  clear(): void {
    this.layouts.clear();
    this.dirty = true;
    this.cancelFlush();
  }

  // ── Persistence ──

  /**
   * Load layout data from disk. Returns the number of entries restored, or 0
   * when no data exists or the version has changed (caller should regenerate).
   *
   * Call once at session start, before the first render cycle, so the entry
   * height cache can be seeded with accurate (measured) layouts instead of
   * fallback estimates.
   */
  async load(): Promise<number> {
    if (this.ephemeral || !this.sessionDataDir) return 0;

    const filePath = path.join(this.sessionDataDir, LAYOUT_FILENAME);
    let raw: string;
    try {
      raw = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'));
    } catch {
      return 0; // File not found or unreadable
    }

    let snapshot: LayoutSnapshot;
    try {
      snapshot = JSON.parse(raw) as LayoutSnapshot;
    } catch {
      return 0; // Corrupt
    }

    // Version check — discard if the engine changed
    if (snapshot.version !== LAYOUT_VERSION) return 0;

    // Width check — discard if terminal has changed substantially (>20 col)
    if (Math.abs(snapshot.termWidth - this.currentTermWidth) > 20) return 0;

    let restored = 0;
    for (const [idStr, layout] of Object.entries(snapshot.entries)) {
      const id = Number(idStr);
      if (Number.isSafeInteger(id) && id >= 0) {
        // load() completes asynchronously after the first Ink commit. A live
        // Yoga measurement recorded while the file was being read is newer
        // and exact for the current process; never replace it with a persisted
        // estimate (or a measurement from an older terminal geometry).
        if (!this.layouts.has(id)) {
          this.layouts.set(id, layout);
          restored++;
        }
      }
    }
    return restored;
  }

  /**
   * Force an immediate disk write. Normally writes are debounced; call this
   * before session end to ensure the latest layout data is persisted.
   */
  async flushNow(): Promise<void> {
    this.cancelFlush();
    if (this.ephemeral || !this.dirty || !this.sessionDataDir) return;
    this.dirty = false;

    const snapshot: LayoutSnapshot = {
      termWidth: this.currentTermWidth,
      version: LAYOUT_VERSION,
      entries: Object.fromEntries(this.layouts),
    };

    const filePath = path.join(this.sessionDataDir, LAYOUT_FILENAME);
    try {
      // Atomic write: write to a temp file, then rename over target.
      // Uses `node:fs/promises` directly — no external dependency needed
      // since layout persistence is a best-effort cache, not critical data.
      const fs = await import('node:fs/promises');
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(filePath)}.${Date.now().toString(36)}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    } catch {
      // Best-effort: layout persistence is a cache, not critical data.
    }
  }

  // ── Private ──

  /** Schedule a debounced flush to disk. */
  private scheduleFlush(): void {
    if (this.ephemeral || !this.sessionDataDir) return;
    if (this.debounceTimer) return; // Already scheduled
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushNow();
    }, DEBOUNCE_MS);
    // An armed debounce must not hold the process open at exit — teardown
    // paths call flushNow()/cancelFlush() themselves.
    this.debounceTimer.unref?.();
  }

  /** Cancel any pending flush. */
  private cancelFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
