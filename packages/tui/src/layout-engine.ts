/**
 * Layout engine — exact line-count, character-count, and overflow computation
 * per history entry kind + terminal width.
 *
 * Pure functions (no React, no Ink, no DOM). Each entry's layout is computed
 * from its content and the current terminal width alone, so it can be cached,
 * serialised, and reused across re-renders and session resumes without
 * mounting the component tree just to discover row heights.
 *
 * The engine replaces the vague `estimateRenderGroupRows` heuristics with
 * deterministic line counts for every entry kind, handling:
 *   - Text wrapping at a given terminal column width
 *   - Tool card chrome (header, rail, footer)
 *   - Code blocks and syntax-highlighted diffs
 *   - Banners (compact / full artwork variant)
 *   - Model-switch cards, brain cards, memory cards, etc.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface EntryLayout {
  /** Entry id the layout belongs to. */
  id: number;
  /** Terminal columns this layout was computed for. */
  termWidth: number;
  /** Computed terminal rows this entry occupies. */
  rows: number;
  /** Total character count of the entry's content. */
  chars: number;
  /** Rows of this entry that overflow above the viewport, 0 at top. */
  overflowBefore: number;
  /** Rows of this entry that overflow below the viewport after clipping. */
  overflowAfter: number;
  /**
   * `estimated` when the layout was seeded from a heuristic (before first
   * real measurement), `measured` after the actual ink component rendered.
   */
  kind: 'estimated' | 'measured';
  /** Version of the scoring function. Bump to invalidate stale caches. */
  version: number;
}

/**
 * Snapshot for one session: map of entry id → layout data computed at a
 * specific terminal width. Persisted alongside the session so resumed
 * sessions restore accurate layout without remounting every entry.
 */
export interface LayoutSnapshot {
  /** Terminal columns at snapshot time. */
  termWidth: number;
  /** Layout version — increment to force re-computation. */
  version: number;
  /** Per-entry layout data. */
  entries: Record<number, EntryLayout>;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Current layout computation version. Bump when the algorithm changes. */
export const LAYOUT_VERSION = 1;

/** Default fallback row count for entries without computed layout. */
export const FALLBACK_ROWS = 3;

/** Max rows budgeted for any single entry during estimation (safety cap). */
const MAX_ESTIMATE_ROWS = 2000;

/**
 * Min width for content text before we give up trying to wrap and just
 * clip. Prevents degenerate behaviour on an impossibly narrow terminal.
 */
const MIN_CONTENT_WIDTH = 16;

// ── Character / line helpers ─────────────────────────────────────────────

/**
 * Count the number of terminal rows a multi-line string occupies when wrapped
 * at `width` columns. Empty strings produce 1 row.
 *
 * Pure — no allocations beyond the row accumulator.
 */
export function wrappedRows(text: string, width: number, maxRows = MAX_ESTIMATE_ROWS): number {
  if (!text) return 1;
  const w = Math.max(MIN_CONTENT_WIDTH, width);
  let rows = 0;
  let lineStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text.charCodeAt(index) !== 10) continue;
    // lineStart..index is one logical line (excluding the \n at index)
    const lineLen = index - lineStart;
    rows += lineLen === 0 ? 1 : Math.max(1, Math.ceil(lineLen / w));
    if (rows >= maxRows) return maxRows;
    lineStart = index + 1;
  }
  return Math.max(1, rows);
}

/**
 * Count the raw characters (code points) in a string that contribute to
 * visible output. Strips ANSI escape sequences before counting.
 */
export function visibleChars(text: string): number {
  // Strip ANSI escapes before counting
  const cleaned = text.replace(/\x1b\[[0-9;]*m/g, '');
  return cleaned.length;
}

// ── Per-kind exact layout computation ────────────────────────────────────

/**
 * Compute the exact terminal rows an entry occupies at the given terminal
 * width. This is the core of the layout engine — it mirrors what the Ink
 * component tree actually produces, but runs in O(1) and does not mount
 * React elements.
 */
export function computeEntryRows(
  kind: string,
  text: string,
  termWidth: number,
  meta?: {
    /** For 'tool' entries: hasBody (whether result body is expanded). */
    hasBody?: boolean;
    /** For 'tool' entries: resultRenderMode. */
    resultRenderMode?: 'simple' | 'extend';
    /** For 'tool' entries: output preview byte length. */
    outputBytes?: number;
    /** For 'banner' entries: whether to render full artwork. */
    fullArtwork?: boolean;
    /** For 'tool-group': entry count in the group. */
    groupCount?: number;
    /** For 'assistant': whether a next-steps panel is rendered. */
    hasNextSteps?: boolean;
    /** For 'assistant' content: how many code blocks, approximate. */
    codeBlockCount?: number;
  },
): number {
  const w = Math.max(MIN_CONTENT_WIDTH, termWidth);

  switch (kind) {
    // ── User entry ──
    // Left border (1) + padding (1) + content wrapped at (w - 2) + optional
    // pasteContent line. The "👤 USER " prefix is ~10 chars, which shares the
    // first content row.
    case 'user': {
      const contentWidth = w - 2; // border + padding
      const baseText = text;
      // pasteContent is folded into `text` by the caller for pure-text sizing.
      // For pure-text computation we assume text already contains pasteContent
      // concatenated if present (caller handles this).
      const lines = baseText.split('\n');
      let rows = 0;
      for (const line of lines) {
        rows += Math.max(1, Math.ceil(line.length / contentWidth));
      }
      return Math.max(1, rows + 1); // +1 for the border chrome row
    }

    // ── Assistant entry ──
    // Header (1) + body (wrapped at contentWidth) + chrome (2: border + padding)
    // + optional next-steps panel (≈ steps * 3 rows + chrome)
    case 'assistant': {
      const contentWidth = w - 2;
      const bodyRows = wrappedRows(text, contentWidth);
      let total = 2 + bodyRows; // header + body
      if (meta?.hasNextSteps) {
        // Header (1) + steps (2 per step estimate) + chrome (border+padding=2)
        total += 4;
      }
      return total;
    }

    // ── Thinking entry ──
    // Header (1) + body (wrapped) + border chrome (2)
    case 'thinking': {
      const contentWidth = w - 2;
      const bodyRows = wrappedRows(text, contentWidth);
      return 3 + bodyRows;
    }

    // ── Tool card ──
    // Header line (1) + optional body (rail + content + footer) when expanded
    case 'tool': {
      const hasBody = meta?.hasBody ?? false;
      const simple = meta?.resultRenderMode === 'simple';
      if (simple || !hasBody) return 2; // header + empty close (╰─)
      // Header (1) + left rail content (wrapped text) + footer (1)
      const contentWidth = w - 2; // left rail padding
      const bodyRows = Math.min(MAX_ESTIMATE_ROWS, wrappedRows(text, contentWidth));
      // Rail top border (from ToolCard header shares the header row)
      // Rail body: bodyRows
      // Rail footer (╰───): 1
      return 2 + bodyRows;
    }

    // ── Tool group ──
    // Group header (1) + entries (each: status mark + arg + meta = 1 row)
    // + left rail (border) + rail top/footer (╭─ / ╰─)
    case 'tool-group': {
      const count = meta?.groupCount ?? 1;
      // Header row + per-entry rows + top rule + footer rule
      // Each entry: 1 row (no wrapping — tool group items are single-line)
      // Left rail shares the per-entry rows
      return 2 + count + 1; // header + entries + footer rule
    }

    // ── Info / Warn / Error ──
    // info: single-line dim text. warn: single-line bold row.
    // error: NoticeCard (border + icon + text wrapped)
    case 'info':
    case 'warn':
      return 1;
    case 'error': {
      // NoticeCard: border top (1) + header (1) + wrapped body + border bottom (1)
      const contentWidth = w - 4; // 2 border + 2 padding
      const bodyRows = wrappedRows(text, contentWidth);
      return 3 + bodyRows;
    }

    // ── Turn summary ──
    // Bordered box with chrome + 1 line text. marginBottom adds 1 extra.
    case 'turn-summary': {
      const contentWidth = w - 4; // border + padding
      const bodyRows = wrappedRows(text, contentWidth);
      return 2 + bodyRows + 1; // border top + body + border bottom + margin
    }

    // ── Model switch card ──
    // Round-bordered card: top (1) + from line (1) + to line (1) + optional
    // shrink line (1) + bottom (1)
    case 'model-switch': {
      let rows = 5; // top border + from + to + activation + bottom border
      if (meta?.hasBody) rows += 1; // shrink warning
      return rows;
    }

    // ── Brain entry ──
    // Left-border panel: header (1) + question (wrapped) + optional decision/
    // rationale/outcome lines (1 each)
    case 'brain': {
      const contentWidth = w - 2;
      let rows = 2; // header + border chrome
      rows += wrappedRows(text, contentWidth);
      if (meta?.hasBody) rows += 2; // decision + outcome
      return rows;
    }

    // ── Memory activation ──
    // Bordered card: top (1) + header line (1) + optional injected line (1) +
    // optional rejected line (1) + bottom (1)
    case 'memory-activation': {
      let rows = 4; // top + header + bottom + margin
      if (text) rows += 1; // detail line
      return rows;
    }

    // ── Memory lifecycle ──
    // Single row: icon + action + label
    case 'memory-lifecycle':
      return 1;

    // ── Confirm entry ──
    // Bordered: top (1) + header (1) + dim text (1) + bottom (1)
    case 'confirm':
      return 4;

    // ── Subagent entry ──
    // First line: icon + label + text. Additional lines: continuation.
    case 'subagent': {
      const lines = text.split('\n');
      return Math.max(1, lines.length);
    }

    // ── Banner ──
    // Full artwork: 5 rows (compact wordmark). Narrow: 3-row identity strip.
    // Extremely narrow: 1-row identity strip.
    case 'banner': {
      if (meta?.fullArtwork === false) {
        return w < 44 ? 3 : 5;
      }
      return w < 44 ? 3 : 5;
    }

    default:
      return FALLBACK_ROWS;
  }
}

/**
 * Count the total characters across all display-relevant fields of an entry.
 * Accounts for the primary text field as well as secondary fields (pasteContent,
 * output preview, detail strings) that contribute to visual length.
 */
export function computeEntryChars(
  kind: string,
  entry: { text?: string; [key: string]: unknown },
): number {
  let total = entry.text ? visibleChars(entry.text as string) : 0;

  // Add secondary text fields that contribute to visual length
  if (kind === 'user' && entry.pasteContent) {
    total += visibleChars(entry.pasteContent as string);
  }
  if (kind === 'tool') {
    if (entry.output) total += visibleChars(entry.output as string);
    if (entry.input) {
      try {
        const serialized =
          typeof entry.input === 'string' ? entry.input : JSON.stringify(entry.input);
        total += visibleChars(serialized);
      } catch {
        /* skip non-serializable inputs */
      }
    }
  }
  if (kind === 'subagent' && entry.detail) {
    total += visibleChars(entry.detail as string);
  }

  return total;
}

// ── Exported computation helpers ─────────────────────────────────────────

/**
 * Compute a full EntryLayout for one entry. Pure — deterministic from inputs.
 */
export function computeLayout(
  id: number,
  kind: string,
  text: string,
  termWidth: number,
  meta?: Parameters<typeof computeEntryRows>[3],
): EntryLayout {
  const chars = computeEntryChars(kind, { text });
  const rows = computeEntryRows(kind, text, termWidth, meta);
  return {
    id,
    termWidth,
    rows: Math.max(1, rows),
    chars,
    overflowBefore: 0,
    overflowAfter: 0,
    kind: 'estimated',
    version: LAYOUT_VERSION,
  };
}

/**
 * Update overflow values for a list of layouts arranged in content order.
 * Each entry gets its `overflowBefore` (rows clipped above viewport) and
 * `overflowAfter` (rows clipped below) computed from the given viewport
 * window.
 *
 * Clip coordinates are in total-content rows. Layout array is in display order.
 */
export function computeOverflow(
  layouts: EntryLayout[],
  viewportTop: number,
  viewportBottom: number,
): EntryLayout[] {
  let accumulated = 0;
  return layouts.map((layout) => {
    const entryStart = accumulated;
    const entryEnd = accumulated + layout.rows;
    accumulated = entryEnd;

    const ob = Math.max(0, Math.min(layout.rows, viewportTop - entryStart));
    const oa = Math.max(0, Math.min(layout.rows, entryEnd - viewportBottom));

    return { ...layout, overflowBefore: ob, overflowAfter: oa };
  });
}
