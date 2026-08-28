/**
 * Entry height cache for the scrollable history viewport.
 *
 * Associates each history entry's stable `id` with its measured row height
 * and maintains a prefix-sum array so `accumulatedHeight(index)` is O(1) —
 * essential for the binary-search-based window computation in the virtual
 * scroll viewport.
 *
 * This module is pure TypeScript — no React, no Ink, no DOM dependencies.
 * It can be unit-tested without mounting components.
 */

/**
 * Default height (in terminal rows) assumed for an entry before its first
 * measurement. 3 rows is a reasonable floor for a single-line entry
 * (border + content + margin) and prevents a flash of zero-height spacers
 * during the first render pass.
 */
const DEFAULT_ENTRY_HEIGHT = 3;

/**
 * Prefix-sum-based height cache for history entries.
 *
 * Stores measured heights keyed by entry `id` and keeps a parallel prefix-sum
 * array for O(1) range-height queries and O(log n) scroll-offset-to-entry-index
 * resolution.
 *
 * Threading note: this class is designed for single-threaded use within one
 * React render cycle. It is NOT thread-safe.
 */
export class EntryHeightCache {
  /** id → measured height in terminal rows */
  private readonly heights = new Map<number, number>();

  /**
   * Prefix-sum of heights in the order last returned by `sync()` (transcript
   * order), with later `record()` / `recordMany()` calls appended.
   * `prefix[i]` = sum of heights for entries with index < i. `prefix[0]` is
   * always 0.
   * Invariant: `prefix.length === this.ids.length + 1` — but only once
   * `prefixDirty` is false. Mutators mark the prefix dirty instead of
   * rebuilding eagerly, so a burst of `record()`/`sync()`/`recordMany()`
   * calls in one render cycle costs a single O(n) rebuild at the first read
   * instead of one O(n) rebuild per mutation. After any mutator, `prefix`
   * may lag until the next read; `size` and `ids` are always authoritative.
   */
  private prefix: number[] = [0];

  /** Ordered entry ids matching the prefix-sum positions. */
  private ids: number[] = [];

  /** True when `prefix` no longer reflects `heights`/`ids` and must be rebuilt. */
  private prefixDirty = false;

  /**
   * Set to `true` after the first call to `sync()`, so `record()` knows the
   * id order is governed by transcript membership and must reject unknown ids.
   * Reset by `clear()`.
   */
  private synced = false;

  /**
   * Record or update the measured height for an entry. O(1) — marks the
   * prefix-sum dirty; the rebuild is deferred to the first read so a burst
   * of records in one render cycle pays for a single rebuild.
   *
   * After the first `sync()`, the id MUST be a member of the synced set or
   * have been previously recorded — unknown ids are rejected with a
   * `RangeError` because appending them at the end would place them at the
   * wrong transcript position, corrupting the virtual scroll viewport.
   * Call `sync()` first if you need to register new ids.
   *
   * Before any `sync()` call (fresh cache), unknown ids are appended in
   * insertion order, which is the only reasonable behaviour when no
   * transcript order exists yet.
   *
   * Returns `true` when the height changed (new or different from last record).
   */
  record(id: number, height: number): boolean {
    if (!Number.isFinite(height) || height < 0) return false;
    // Zero is a legal height: a mounted group whose content is hidden (e.g.
    // a thinking entry with model reasoning display off) renders no rows, and
    // the cache must agree with the screen or every row of the stale estimate
    // becomes phantom scroll space (wheel turns, screen doesn't move, then
    // jumps — plus permanent blank bands the underfill pass can't see).
    const clamped = Math.max(0, Math.round(height));
    const prev = this.heights.get(id);
    if (prev === clamped) return false;

    if (prev === undefined) {
      if (this.synced) {
        throw new RangeError(
          `record: id ${id} is not in the cache; call sync() first to register new ids`,
        );
      }
      this.ids.push(id);
    }
    this.heights.set(id, clamped);
    this.prefixDirty = true;
    return true;
  }

  /**
   * Synchronize cache membership/order with the retained transcript in one
   * O(n) rebuild. Missing entries receive a bounded estimate immediately, so
   * the first render of a resumed/long session can be virtualized instead of
   * mounting the entire history tree just to discover its height.
   */
  sync(entryIds: readonly number[], estimatedHeight = DEFAULT_ENTRY_HEIGHT): boolean {
    const clampedEstimate = Math.max(1, Math.round(estimatedHeight));
    const retained = new Set(entryIds);
    let changed = this.ids.length !== entryIds.length;
    for (const id of this.heights.keys()) {
      if (!retained.has(id)) {
        this.heights.delete(id);
        changed = true;
      }
    }
    for (const id of entryIds) {
      if (!this.heights.has(id)) {
        this.heights.set(id, clampedEstimate);
        changed = true;
      }
    }
    // Compare order only over the overlap; a length mismatch is already
    // caught above as a membership change, and ids beyond the overlap are
    // undefined (which would count as a mismatch anyway).
    if (!changed) {
      const overlap = Math.min(entryIds.length, this.ids.length);
      for (let index = 0; index < overlap; index++) {
        if (entryIds[index] !== this.ids[index]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;
    this.ids = [...entryIds];
    this.prefixDirty = true;
    this.synced = true;
    return true;
  }

  /**
   * Update several measured estimates with a single deferred prefix rebuild.
   *
   * Rows MUST reference ids already registered via `sync()`. Unknown ids are
   * rejected with a `RangeError` because appending them at the end would place
   * them at the wrong transcript position until the next `sync()`, corrupting
   * the virtual scroll viewport. Call `sync()` first if you need to register
   * new ids. Duplicate ids within one batch are last-write-wins (each row is
   * applied in order).
   */
  recordMany(rows: Iterable<readonly [id: number, height: number]>): boolean {
    let changed = false;
    for (const [id, height] of rows) {
      // Silently skip invalid rows, mirroring record()'s early-return.
      if (!Number.isFinite(height) || height < 0) continue;
      const clamped = Math.max(0, Math.round(height));
      if (this.heights.get(id) === clamped) continue;
      if (!this.heights.has(id)) {
        throw new RangeError(
          `recordMany: id ${id} is not in the cache; call sync() first to register new ids`,
        );
      }
      this.heights.set(id, clamped);
      changed = true;
    }
    if (changed) this.prefixDirty = true;
    return changed;
  }

  /**
   * Total height in rows of all measured entries.
   * Amortized O(1) — returns the last prefix-sum entry, rebuilding once if dirty.
   */
  totalHeight(): number {
    this.ensurePrefix();
    return this.prefix[this.prefix.length - 1] ?? 0;
  }

  /**
   * Accumulated row height of entries with index < `entryIndex`.
   * `accumulatedHeight(0)` = 0. Clamps to total height when
   * `entryIndex > ids.length`. O(1) via prefix-sum lookup.
   */
  accumulatedHeight(entryIndex: number): number {
    if (entryIndex <= 0) return 0;
    this.ensurePrefix();
    if (entryIndex >= this.prefix.length) {
      return this.prefix[this.prefix.length - 1] ?? 0;
    }
    return this.prefix[entryIndex] ?? 0;
  }

  /**
   * Look up the measured height for a single entry id.
   * Returns `undefined` when the entry has never been measured.
   */
  getHeight(id: number): number | undefined {
    return this.heights.get(id);
  }

  /**
   * Number of entries currently tracked.
   */
  get size(): number {
    return this.ids.length;
  }

  /**
   * Find the entry index whose accumulated range contains the given
   * vertical `rowOffset` from the top of all content.
   *
   * Binary search on the prefix-sum array. O(log n).
   * Returns `0` for offsets at or before the first entry.
   * Returns `ids.length` for offsets past the last entry.
   */
  entryIndexAtOffset(rowOffset: number): number {
    this.ensurePrefix();
    const total = this.totalHeight();
    if (total <= 0 || rowOffset <= 0) return 0;
    if (rowOffset >= total) return this.ids.length;

    // Binary search: find the first index where prefix[i+1] > rowOffset.
    let lo = 0;
    let hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      // `mid + 1 <= ids.length` is guaranteed by the loop bounds (prefix has
      // ids.length + 1 entries), so the fallback is unreachable — it only
      // satisfies noUncheckedIndexedAccess.
      const midEnd = this.prefix[mid + 1] ?? Number.POSITIVE_INFINITY;
      if (midEnd <= rowOffset) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  /**
   * Remove all cached heights and reset to empty state.
   */
  clear(): void {
    this.heights.clear();
    this.ids = [];
    this.prefix = [0];
    this.prefixDirty = false;
    this.synced = false;
  }

  /**
   * Drop cached rows for entries no longer present in the bounded TUI history
   * and restore prefix ordering to match the current entry array.
   *
   * Unlike `sync()`, retained ids that are not yet measured are NOT seeded
   * with a placeholder — call `sync()` if you need bounded estimates for ids
   * that have never been recorded.
   */
  retain(entryIds: readonly number[]): void {
    const retained = new Set(entryIds);
    let changed = this.ids.length !== entryIds.length;
    for (const id of this.heights.keys()) {
      if (!retained.has(id)) {
        this.heights.delete(id);
        changed = true;
      }
    }
    const nextIds = entryIds.filter((id) => this.heights.has(id));
    if (!changed) changed = nextIds.some((id, index) => id !== this.ids[index]);
    if (!changed) return;
    this.ids = nextIds;
    this.prefixDirty = true;
  }

  // ── Private ──

  /** Rebuild the prefix-sum once if any mutation since the last read dirtied it. */
  private ensurePrefix(): void {
    if (!this.prefixDirty) return;
    this.rebuild();
    this.prefixDirty = false;
  }

  /** Rebuild the prefix-sum array from current heights in insertion order. */
  private rebuild(): void {
    const p: number[] = [0];
    for (const id of this.ids) {
      const h = this.heights.get(id) ?? DEFAULT_ENTRY_HEIGHT;
      p.push((p[p.length - 1] ?? 0) + h);
    }
    this.prefix = p;
  }
}

/**
 * Compute the visible window slice for a virtual-scrolled entry list.
 *
 * Given the total measured content, viewport size, scroll offset, and entry
 * array, determines which entries to render and how tall the top/bottom spacer
 * elements should be.
 *
 * All measurements are in terminal rows.
 *
 * Returns a result with `startIdx`, `endIdx`, `spacerAbove`, and `spacerBelow`
 * that the caller uses to render only the visible window.
 */
interface ComputeWindowResult {
  /** Index of the first entry to render (inclusive). */
  startIdx: number;
  /** Index of the last entry to render (exclusive, like Array.slice end). */
  endIdx: number;
  /** Row height of the spacer above the visible window. 0 when at top. */
  spacerAbove: number;
  /** Row height of the spacer below the visible window. 0 when at bottom. */
  spacerBelow: number;
  /** Total content height measured. */
  totalHeight: number;
  /** Whether the computed window differs from a flat render of all entries. */
  windowed: boolean;
}

/**
 * Minimum row budget for the visible window. Ensures the viewport always has
 * *some* rendered entries even when the viewport is very small. Picked so a
 * 10-row viewport shows at least ~3 entries, giving the user context for
 * scrolling.
 */
const MIN_WINDOW_ROWS = 8;

/**
 * Compute which entries should be rendered in a virtual-scrolled viewport.
 *
 * Pure function — no side effects, no state mutations. Exported for testing.
 *
 * @param totalHeight  - Total measured height of all entries in rows.
 * @param viewportRows - Number of visible rows in the viewport.
 * @param scrollOffset - Rows scrolled up from the bottom (0 = pinned to newest).
 * @param entryCount   - Total number of entries.
 * @param cache        - EntryHeightCache with measured heights.
 * @returns A {@link ComputeWindowResult} describing the visible slice.
 */
export function computeWindow(
  totalHeight: number,
  viewportRows: number,
  scrollOffset: number,
  entryCount: number,
  cache: EntryHeightCache,
): ComputeWindowResult {
  // Trivial case: no content or viewport fits all content.
  if (totalHeight <= 0 || entryCount === 0) {
    return {
      startIdx: 0,
      endIdx: 0,
      spacerAbove: 0,
      spacerBelow: 0,
      totalHeight: 0,
      windowed: false,
    };
  }

  // When all content fits in the viewport, don't window.
  if (totalHeight <= viewportRows) {
    return {
      startIdx: 0,
      endIdx: entryCount,
      spacerAbove: 0,
      spacerBelow: 0,
      totalHeight,
      windowed: false,
    };
  }

  // Viewport top in content-space: maximum is totalHeight - viewportRows
  // (scrolled to oldest), minimum is 0 (pinned to newest).
  const viewportTop = Math.max(0, totalHeight - viewportRows - scrollOffset);
  const viewportBottom = viewportTop + viewportRows;

  // Binary-search for the first entry that starts at or before viewportTop.
  const startIdx = cache.entryIndexAtOffset(viewportTop);
  const startEntryTop = cache.accumulatedHeight(startIdx);
  const spacerAbove = Math.max(0, viewportTop - startEntryTop);

  // Walk forward from startIdx until we exceed viewportBottom + MIN_WINDOW_ROWS.
  let endIdx = startIdx;
  // Reserve the MIN_WINDOW_ROWS budget below the visible area so rapid
  // scrolling doesn't flash empty spacer while entries are being measured.
  const scanTarget = viewportBottom + MIN_WINDOW_ROWS;
  while (endIdx < entryCount) {
    const entryEnd = cache.accumulatedHeight(endIdx + 1);
    if (entryEnd >= scanTarget) {
      endIdx = endIdx + 1; // include the entry that crossed the threshold
      break;
    }
    endIdx++;
  }
  endIdx = Math.min(entryCount, endIdx);

  const spacerBelow = Math.max(0, totalHeight - cache.accumulatedHeight(endIdx));

  return {
    startIdx,
    endIdx,
    spacerAbove,
    spacerBelow,
    totalHeight,
    windowed: true,
  };
}
