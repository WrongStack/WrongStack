import {
  type DiffLineKind,
  type DiffLineRow,
  type DiffPreview,
  parseUnifiedDiffPreview,
} from '@wrongstack/tools/tool-diff';
import type React from 'react';
import { memo } from 'react';
import {
  type HLState,
  highlightLine,
  type Lang,
  langFromPath,
  type Token,
} from '../../highlight.js';
import { Box, Text } from '../../ink.js';
import {
  displayWidth,
  sanitizeTerminalText,
  splitDisplay,
  truncateDisplay,
} from '../../terminal-width.js';
import { theme } from '../../theme.js';
import {
  collectMultiFileDiffItems,
  countUnifiedDiffChanges,
  extractUnifiedDiffText,
  joinReplaceDiffs,
  newFileDiffFromWriteInput,
} from './code-block-diff-helpers.js';
import { stringOf, tryParseJson } from './utils.js';

// ── Types ──

// The rich diff model (row shape + unified-diff parser) is now the single
// source of truth in @wrongstack/tools/tool-diff, shared with the WebUI/HQ.
// This file keeps only the TUI-specific rendering (ink/theme/wrap/tab-expand).
// Imported for local use AND re-exported so this module's public API is intact.
// Re-export straight from the source module (not the local import bindings) so
// the dts bundler can drop the chain without leaving a dangling import behind.
export type { DiffLineKind, DiffLineRow, DiffPreview } from '@wrongstack/tools/tool-diff';

/**
 * A parsed diff paired with the file it belongs to. Used when a tool
 * produces diffs for several files at once (currently `replace`); each
 * `DiffFilePreview` renders as one labeled `DiffFileBlock`.
 */
export interface DiffFilePreview {
  path: string;
  preview: DiffPreview;
}

interface OmittedDiffSummary {
  fileCount: number;
  added: number;
  removed: number;
}

/** Renderable file previews plus aggregate data for files omitted by the cap. */
export type DiffFilePreviews = DiffFilePreview[] & {
  omitted?: OmittedDiffSummary | undefined;
};

// ── Constants ──

/** Max code-block lines rendered before a "+N more" footer. */
const MAX_CODE_LINES = 80;
/**
 * Hard ceiling for one file's rendered diff preview. Diff rows are React/Ink
 * elements and therefore retained by the active virtual-history window; an
 * unbounded preview lets a single generated-file edit defeat virtualization.
 * Totals for the whole diff remain available through `added`/`removed`, while
 * the footer reports the hidden portion.
 */
export const DIFF_MAX_LINES = 200;
/** Maximum number of per-file diff blocks retained for one tool entry. */
export const MULTI_DIFF_MAX_FILES = 20;
/** Maximum rendered diff rows retained across every file in one tool entry. */
export const MULTI_DIFF_MAX_ROWS = 400;
/**
 * Wrap budget when the caller doesn't supply `contentWidth` (e.g. the
 * approval dialog). Matches the historical per-row cap so the layout risk
 * on narrow terminals is unchanged — but the content wraps instead of
 * being cut off.
 */
const DIFF_FALLBACK_WRAP_WIDTH = 100;
/**
 * Display width for a hard tab. Matches the near-universal terminal default
 * (8-column tab stops), so a tab-indented file (Go, Makefiles, kernel C, …)
 * shows the same indentation depth here as it does in `git diff` or the
 * read view, and so the wrap + wash-padding math — which counts characters —
 * agrees with the number of columns the terminal actually advances.
 */
const HARD_TAB_WIDTH = 8;

/**
 * Expand hard tabs to spaces at fixed tab stops, measured from column 0 of
 * the passed text.
 *
 * A literal `\t` is doubly broken for the diff renderer:
 *
 * 1. Inside a background-washed `<Text>` the terminal does NOT paint the
 *    cells a tab skips over — it just advances the cursor — so a tab-indented
 *    add/del line shows a colourless gap before the code (the "no background
 *    at the start of the line" artifact).
 * 2. The wrap ({@link wrapTokens}) and wash-pad ({@link DiffBlock}) math count
 *    a tab as a single character while it occupies up to `HARD_TAB_WIDTH`
 *    columns on screen, so the trailing-space pad overshoots and the row
 *    spills onto the next line.
 *
 * Converting tabs to real spaces up front makes the stored text, the wrap
 * math, and the painted background all agree. A no-tab fast path keeps the
 * common (space-indented) case allocation-free.
 */
function expandTabs(text: string, tabWidth: number = HARD_TAB_WIDTH): string {
  if (!text.includes('\t')) return text;
  let out = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const advance = tabWidth - (col % tabWidth);
      out += ' '.repeat(advance);
      col += advance;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

// ── CodeBlock ──

/** Syntax-highlighted, framed code block. */
function CodeBlockImpl({
  code,
  lang,
  contentWidth,
}: {
  code: string;
  lang: Lang;
  contentWidth: number;
}): React.ReactElement {
  let lines = sanitizeTerminalText(code, HARD_TAB_WIDTH).replace(/\n+$/, '').split('\n');
  const hidden = Math.max(0, lines.length - MAX_CODE_LINES);
  if (hidden > 0) lines = lines.slice(0, MAX_CODE_LINES);
  const gutterW = String(lines.length).length;
  // Pin the box to a deterministic width instead of letting Ink stretch it.
  // The box carries marginLeft 2 + round border (1 each side) + paddingX 1 each
  // side. Yoga's stretch does NOT subtract this marginLeft from the stretched
  // width, so the box would grow `contentWidth` wide and then sit 2 cols past
  // its container — the right border wraps to the next line's left edge (the
  // "boxes overflow / extra chars on the next line" bug). An explicit width
  // makes the box exactly fill the panel's inner area (100%) and never wrap.
  const boxWidth = Math.max(1, contentWidth - 2);
  // Text area inside the frame: box width − border(2) − paddingX(2) − gutter.
  const maxW = Math.max(1, Math.min(boxWidth - 4 - gutterW - 1, 120));
  let carry: HLState = {};
  const rows = lines.map((raw) => {
    // Expand hard tabs before measuring/truncating so a tab-indented line
    // isn't under-counted (tab = 1 char but many columns) and made to wrap.
    const expanded = expandTabs(raw);
    const display = truncateDisplay(expanded, maxW);
    const r = highlightLine(display, lang, carry);
    carry = r.carry;
    return r.tokens;
  });
  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      flexShrink={0}
      marginLeft={2}
      marginY={0}
      borderStyle="round"
      borderColor={theme.borderDefault}
      paddingX={1}
    >
      {lang !== 'plain' ? <Text dimColor>{lang}</Text> : null}
      {rows.map((tokens, i) => (
        <Text key={i}>
          <Text dimColor>{`${String(i + 1).padStart(gutterW, ' ')} `}</Text>
          {tokens.length === 0
            ? ' '
            : tokens.map((t, j) => (
                <Text
                  key={j}
                  dimColor={Boolean(t.dim)}
                  bold={Boolean(t.bold)}
                  {...(t.color ? { color: t.color } : {})}
                >
                  {t.text}
                </Text>
              ))}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor italic>{`… +${hidden} more line${hidden === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  );
}

// ── DiffBlock ──

/**
 * Minimum number of files before a summary footer is rendered above the
 * per-file blocks. Below this threshold each file's own `… +N -M hidden`
 * footer carries enough signal; above it, a single aggregate line keeps
 * the screen from being drowned in per-file tail lines.
 *
 * This is the default when no user-tunable value is supplied. The
 * settings picker exposes `MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS` so
 * users can raise the cutoff (e.g. for very wide terminals) or lower
 * it (e.g. for tiny scrollback), or set it to 0 to suppress the
 * summary entirely.
 */
export const MULTI_DIFF_SUMMARY_THRESHOLD = 5;

/**
 * Aggregate stats across a list of per-file diffs — used to print a
 * single summary line at the top of a multi-file diff view when there
 * are enough files to make the rollup useful.
 */
export interface MultiDiffSummary {
  fileCount: number;
  added: number;
  removed: number;
  hiddenAdded: number;
  hiddenRemoved: number;
  /** Number of rendered files whose preview was truncated (has hidden rows).
   *  Does not include files omitted entirely by the multi-file render ceiling;
   *  those are tracked separately via {@link omittedFiles}. */
  truncatedFiles: number;
  /** Files omitted entirely by the multi-file render ceiling. Guaranteed non-negative. */
  omittedFiles: number;
}

/**
 * Sum the totals of a list of per-file diff previews. Files that were
 * parsed but have no rows (e.g. entirely empty after the no-op skip) are
 * excluded from the rollup so the summary reflects what the user will
 * actually see rendered below.
 */
export function summarizeMultiFileDiffs(items: DiffFilePreviews): MultiDiffSummary {
  let added = 0;
  let removed = 0;
  let hiddenAdded = 0;
  let hiddenRemoved = 0;
  let truncatedFiles = 0;
  for (const item of items) {
    added += item.preview.added;
    removed += item.preview.removed;
    hiddenAdded += item.preview.hiddenAdded;
    hiddenRemoved += item.preview.hiddenRemoved;
    if (item.preview.hidden > 0) truncatedFiles += 1;
  }
  const omitted = items.omitted;
  if (omitted) {
    added += omitted.added;
    removed += omitted.removed;
  }
  return {
    fileCount: items.length + (omitted?.fileCount ?? 0),
    added,
    removed,
    hiddenAdded,
    hiddenRemoved,
    truncatedFiles,
    omittedFiles: omitted?.fileCount ?? 0,
  };
}

/**
 * Format a multi-file diff summary as a single dim italic line, suitable
 * for rendering above the per-file blocks. Mirrors the per-file footer's
 * `… +N -M hidden` shape so a reader who has seen the footer recognises
 * the format. Returns `null` when there's nothing useful to surface
 * (no files, or below the user's threshold where the per-file footer
 * already covers the rollup).
 *
 * @param threshold User-tunable cutoff. Pass `MULTI_DIFF_SUMMARY_THRESHOLD`
 *   for the default behaviour, `0` to suppress the summary entirely
 *   (always returns null), or a positive number to set a custom cutoff.
 *   A negative value is treated as "use default" so callers can pass an
 *   `undefined`-coerced settings value without a separate branch.
 */
export function formatMultiDiffSummary(
  summary: MultiDiffSummary,
  threshold: number = MULTI_DIFF_SUMMARY_THRESHOLD,
): string | null {
  if (threshold === 0) return null;
  const effectiveThreshold = threshold < 0 ? MULTI_DIFF_SUMMARY_THRESHOLD : threshold;
  if (summary.fileCount < effectiveThreshold) return null;
  const parts: string[] = [`${summary.fileCount} files`];
  if (summary.added > 0) parts.push(`+${summary.added}`);
  if (summary.removed > 0) parts.push(`-${summary.removed}`);
  if (summary.hiddenAdded > 0 || summary.hiddenRemoved > 0) {
    const hiddenParts: string[] = [];
    if (summary.hiddenAdded > 0) hiddenParts.push(`+${summary.hiddenAdded}`);
    if (summary.hiddenRemoved > 0) hiddenParts.push(`-${summary.hiddenRemoved}`);
    parts.push(
      `… ${hiddenParts.join(' ')} hidden across ${summary.truncatedFiles} file${summary.truncatedFiles === 1 ? '' : 's'}`,
    );
  }
  const omittedFiles = summary.omittedFiles ?? 0;
  if (omittedFiles > 0) {
    parts.push(`${omittedFiles} more file${omittedFiles === 1 ? '' : 's'} not rendered`);
  }
  return parts.join(' · ');
}

/**
 * One labeled diff — used to render a per-file block inside multi-file
 * diff views (e.g. when `replace` modifies several files). The path label
 * is rendered dim and italic so the file boundary is visible without
 * competing with the add/remove wash.
 */
export function DiffFileBlock({
  path,
  preview,
  useColor = true,
  contentWidth,
}: {
  path: string;
  preview: DiffPreview;
  /** Pass-through to {@link DiffBlock}. See that component for details. */
  useColor?: boolean | undefined;
  /** Pass-through to {@link DiffBlock}. See that component for details. */
  contentWidth?: number | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor italic>
        {path}
      </Text>
      <DiffBlock
        rows={preview.rows}
        hidden={preview.hidden}
        added={preview.added}
        removed={preview.removed}
        hiddenAdded={preview.hiddenAdded}
        hiddenRemoved={preview.hiddenRemoved}
        useColor={useColor}
        lang={langFromPath(path)}
        contentWidth={contentWidth}
      />
    </Box>
  );
}

/**
 * Human-readable change-size line for a diff — `Added N lines, removed M
 * lines` (Claude Code phrasing). Omits the zero side; returns `null` when
 * nothing changed so callers can skip the line entirely.
 */
export function formatDiffStats(added: number, removed: number): string | null {
  const parts: string[] = [];
  if (added > 0) parts.push(`added ${added} line${added === 1 ? '' : 's'}`);
  if (removed > 0) parts.push(`removed ${removed} line${removed === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Return the token list to render on a diff wash (`diffAddBg` /
 * `diffDelBg`). When `onWash` is false the input is returned unchanged —
 * plain-background rendering keeps the conventional dim comment look and
 * there is no contrast reason to intervene.
 *
 * When `onWash` is true, comment tokens are re-pointed from the
 * `syntax.comment` role to `syntax.commentOnWash` and lose their dim flag.
 * `syntax.comment` resolves to `theme.textMuted`, which is chosen to recede
 * against `theme.surface` and therefore falls below WCAG AA on either wash;
 * `syntax.commentOnWash` resolves to `theme.textSecondary`, which clears both
 * (≥ 4.5) while keeping the comment visually secondary. Because both sides
 * are ROLES, the promotion follows `/theme` automatically instead of pinning
 * one hardcoded grey for all 35 presets.
 *
 * Non-comment tokens pass through unchanged so the rest of the line keeps its
 * syntax palette on the wash.
 *
 * Exported for unit testing — `renderTokens` calls it before mapping to
 * `<Text>` elements so the override logic itself stays a pure function.
 */
export function applyWashTokens(tokens: Token[], onWash: boolean): Token[] {
  if (!onWash) return tokens;
  return tokens.map((t) => {
    if (t.color !== 'syntax.comment') return t;
    return { ...t, color: 'syntax.commentOnWash', dim: false };
  });
}

/**
 * Render highlight tokens as nested `<Text>` segments. Tokens without a
 * color inherit the enclosing default foreground, so the same token list
 * reads correctly both on the plain background (context lines) and on the
 * dark add/del washes. `onWash` switches into "sitting on a dark
 * green/maroon diff wash" mode — see {@link applyWashTokens} for the
 * contrast rationale and the override rules.
 */
function renderTokens(tokens: Token[], onWash: boolean = false): React.ReactNode {
  const effective = applyWashTokens(tokens, onWash);
  if (effective.length === 0) return ' ';
  return effective.map((t, j) => (
    <Text
      key={j}
      dimColor={Boolean(t.dim)}
      bold={Boolean(t.bold)}
      {...(t.color ? { color: t.color } : {})}
    >
      {t.text}
    </Text>
  ));
}

/**
 * Hard-wrap a highlighted token stream into segments of at most `width`
 * display characters. Splitting happens on the token list (not the raw
 * string) so a token that straddles the boundary keeps its color/style on
 * both sides. Always returns at least one segment so empty rows still
 * render as a (blank) line.
 */
function wrapTokens(tokens: Token[], width: number): Token[][] {
  if (width <= 0) return [tokens];
  const segments: Token[][] = [];
  let current: Token[] = [];
  let currentWidth = 0;
  for (const t of tokens) {
    let text = t.text;
    while (text.length > 0) {
      const room = width - currentWidth;
      if (room <= 0) {
        segments.push(current);
        current = [];
        currentWidth = 0;
        continue;
      }
      const [piece, rest] = splitDisplay(text, room);
      if (!piece) {
        segments.push(current);
        current = [];
        currentWidth = 0;
        continue;
      }
      current.push({ ...t, text: piece });
      currentWidth += displayWidth(piece);
      text = rest;
    }
  }
  if (current.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}

export function DiffBlock({
  rows,
  hidden,
  added = 0,
  removed = 0,
  hiddenAdded = 0,
  hiddenRemoved = 0,
  useColor = true,
  lang = 'plain',
  showStats = true,
  contentWidth,
}: {
  rows: DiffLineRow[];
  hidden: number;
  /**
   * Total lines added across the whole diff (not just the visible slice).
   * Surfaced in the `⎿  Added N lines, removed M lines` stats line so the
   * reader knows the change size even when the body is truncated.
   */
  added?: number | undefined;
  /** Total lines removed across the whole diff (not just the visible slice). */
  removed?: number | undefined;
  hiddenAdded?: number | undefined;
  hiddenRemoved?: number | undefined;
  /**
   * When true (default), added/removed rows get a dark green/maroon
   * background wash (Claude Code style) with normal-brightness,
   * syntax-highlighted foreground text. When false, only the `+`/`-`
   * markers get colored (bright green/red, bold) so the diff stays
   * readable on terminals that don't support truecolor backgrounds
   * (TERM=xterm, `NO_COLOR=1`, etc.). Pass `theme.supportsBackground`
   * from the entry-point.
   */
  useColor?: boolean | undefined;
  /**
   * Syntax-highlight language for line bodies (derive from the touched
   * file's extension via `langFromPath`). `plain` disables highlighting.
   */
  lang?: Lang | undefined;
  /**
   * Render the leading `⎿  Added N lines, removed M lines` stats line.
   * Callers that print their own header/stats (e.g. the Update(path)
   * entry header) pass `false` to avoid the duplicate.
   */
  showStats?: boolean | undefined;
  /**
   * Terminal width available to this block. Line bodies longer than the
   * remaining budget hard-wrap onto continuation rows (blank gutter, blank
   * marker cell, same background wash) so the full line content is always
   * visible without ever flowing under the gutter. When omitted, wrapping
   * falls back to a 100-char budget.
   */
  contentWidth?: number | undefined;
}): React.ReactElement {
  // Single-column gutter (Claude Code style): each row shows ONE line
  // number — the old line for deletions, the new line for additions and
  // context.
  const lineNoOf = (row: DiffLineRow): number | undefined =>
    row.kind === 'del' ? row.oldLine : (row.newLine ?? row.oldLine);
  let gutterWidth = 1;
  for (const r of rows) {
    const n = lineNoOf(r);
    if (typeof n === 'number' && String(n).length > gutterWidth) gutterWidth = String(n).length;
  }
  const blank = ' '.repeat(gutterWidth);

  const markerFor = (kind: DiffLineKind) => {
    if (kind === 'add') return '+';
    if (kind === 'del') return '-';
    return ' ';
  };

  const textForDisplay = (row: DiffLineRow) => {
    // Expand hard tabs to spaces so tab-indented lines (Go, Makefiles, …)
    // render with painted background under their indentation and don't
    // overshoot the wrap/pad budget — see {@link expandTabs}.
    if ((row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx') && row.text.length > 0) {
      return sanitizeTerminalText(expandTabs(row.text.slice(1)), HARD_TAB_WIDTH) || ' ';
    }
    return sanitizeTerminalText(expandTabs(row.text), HARD_TAB_WIDTH) || ' ';
  };

  const stats = showStats ? formatDiffStats(added, removed) : null;

  // Row anatomy: box margin (2) + `   ` prefix (3) + line number + ` X `
  // marker cell (3). Keep one terminal column as a wrap guard when the width
  // is known: writing a printable trailing-space background into the final
  // column can leave some terminals in pending-wrap state, so the next reset /
  // newline appears as a visual spill even though the measured string is
  // exactly `contentWidth` wide.
  const terminalWrapGuard = typeof contentWidth === 'number' ? 1 : 0;
  const bodyBudget =
    typeof contentWidth === 'number'
      ? Math.max(1, contentWidth - (2 + 3 + gutterWidth + 3 + terminalWrapGuard))
      : DIFF_FALLBACK_WRAP_WIDTH;
  // When the width is known, the add/del wash pads its body out to the guarded
  // `bodyBudget` with trailing spaces so the dark green/maroon background
  // spans almost the whole line without touching the terminal's last column.
  // This is required because Ink only paints a background behind actual
  // characters (a `<Text backgroundColor>` colours its trailing spaces; a
  // `<Box backgroundColor>` does NOT fill the empty area), so the wash needs
  // real padding chars. The approval-dialog path (no contentWidth) skips the
  // padding to avoid over-wide rows in the bordered confirm box.
  const hasWidth = typeof contentWidth === 'number';
  const padBody = (seg: Token[]): number => {
    if (!hasWidth) return 0;
    const len = seg.reduce((n, t) => n + displayWidth(t.text), 0);
    return Math.max(0, bodyBudget - len);
  };
  // Continuation-row prefix: same width as `   ${ln} X ` so wrapped
  // segments line up with the first segment's body column.
  const contPrefix = `   ${blank}   `;

  const hiddenStats: string[] = [];
  if (hiddenAdded > 0) hiddenStats.push(`+${hiddenAdded}`);
  if (hiddenRemoved > 0) hiddenStats.push(`-${hiddenRemoved}`);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      {stats ? (
        <Text>
          <Text dimColor>{'⎿  '}</Text>
          <Text>{stats}</Text>
        </Text>
      ) : null}
      {rows.map((row, i) => {
        const key = i;
        if (row.kind === 'hunk') {
          // Claude Code hides hunk headers — the line numbers already carry
          // position. A leading hunk renders nothing; between hunks a dim
          // `⋯` marks the gap.
          if (i === 0) return null;
          return (
            <Text key={key} dimColor>
              {`   ${blank} ⋯`}
            </Text>
          );
        }
        if (row.kind === 'meta') {
          return (
            <Text key={key} dimColor>
              {`   ${blank}   ${sanitizeTerminalText(row.text)}`}
            </Text>
          );
        }
        const n = lineNoOf(row);
        const ln = typeof n === 'number' ? String(n).padStart(gutterWidth, ' ') : blank;
        const body = textForDisplay(row);
        // Fresh highlight state per row: diff rows are disjoint slices of
        // the file, so carrying block-comment state across add/del pairs
        // would color the wrong lines.
        const tokens = highlightLine(body, lang).tokens;
        // Long lines hard-wrap onto continuation rows (blank gutter, blank
        // marker cell) instead of being mid-line truncated — the full line
        // content always renders.
        const segments = wrapTokens(tokens, bodyBudget);
        if (row.kind === 'ctx') {
          return (
            <Box key={key} flexDirection="column">
              {segments.map((seg, si) => (
                <Text key={si}>
                  <Text dimColor>{si === 0 ? `   ${ln}   ` : contPrefix}</Text>
                  {renderTokens(seg)}
                </Text>
              ))}
            </Box>
          );
        }
        const marker = markerFor(row.kind);
        const markerColor = row.kind === 'add' ? theme.success : theme.error;
        // Truecolor path: the whole row (number + marker + body) sits on a
        // dark green/maroon wash; the body keeps its syntax colors, which
        // stay readable on the dark tint. Fallback path: no wash, the bold
        // colored marker alone distinguishes add vs del.
        if (useColor) {
          const bg = row.kind === 'add' ? theme.diffAddBg : theme.diffDelBg;
          // Wash lives on the <Text> (not the parent <Box>): Ink paints a
          // background behind characters only, so the whole line — prefix,
          // marker, syntax-highlighted body and the trailing pad — must sit
          // inside one background <Text> for the wash to reach the edge.
          //
          // `onWash: true` lets `renderTokens` promote comment tokens off
          // dim/gray — see {@link renderTokens}. Without that promotion the
          // dim-gray comment collapses into the dark green/maroon wash and
          // becomes unreadable.
          return (
            <Box key={key} flexDirection="column">
              {segments.map((seg, si) => {
                const pad = padBody(seg);
                return (
                  <Text key={si} backgroundColor={bg}>
                    {si === 0 ? (
                      <>
                        <Text dimColor>{`   ${ln} `}</Text>
                        <Text color={markerColor} bold>
                          {marker}
                        </Text>
                        <Text> </Text>
                      </>
                    ) : (
                      <Text dimColor>{contPrefix}</Text>
                    )}
                    {renderTokens(seg, true)}
                    {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
                  </Text>
                );
              })}
            </Box>
          );
        }
        return (
          <Box key={key} flexDirection="column">
            {segments.map((seg, si) => (
              <Text key={si}>
                {si === 0 ? (
                  <>
                    <Text dimColor>{`   ${ln} `}</Text>
                    <Text color={markerColor} bold>
                      {marker}
                    </Text>
                    <Text> </Text>
                  </>
                ) : (
                  <Text dimColor>{contPrefix}</Text>
                )}
                {renderTokens(seg)}
              </Text>
            ))}
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Text dimColor italic>
          {`   ${blank}  … ${hidden} more line${hidden === 1 ? '' : 's'}${
            hiddenStats.length > 0 ? ` (${hiddenStats.join(' ')} hidden)` : ''
          }`}
        </Text>
      ) : null}
    </Box>
  );
}

// ── Diff parsing ──

/**
 * Parse a unified-diff string into a {@link DiffPreview}. Thin wrapper over the
 * shared, single-source-of-truth `parseUnifiedDiffPreview` in
 * @wrongstack/tools/tool-diff (which the WebUI and HQ also read). Kept as a
 * local export so this module's many callers and tests are unchanged.
 */
export function parseUnifiedDiff(diff: string, maxLines: number): DiffPreview {
  return parseUnifiedDiffPreview(diff, maxLines);
}

/**
 * Pull a unified-diff string out of a tool's JSON output, then turn it
 * into a small, structured preview suitable for colour-coded rendering.
 */
export function extractDiffPreview(
  toolName: string,
  output: string | undefined,
  input?: unknown | undefined,
): DiffPreview | undefined {
  if (!output) return undefined;
  const text = output.trim();
  if (!text) return undefined;

  let diff: string | undefined;
  if (toolName === 'edit' || toolName === 'diff' || toolName === 'write') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      diff =
        toolName === 'write' && obj['created'] === true
          ? (newFileDiffFromWriteInput(obj, input) ?? stringOf(obj['diff']))
          : stringOf(obj['diff']);
    } else {
      // The tool-output serializer renders edit/diff/write results as a
      // human-readable string (a header line such as
      // `edit (path=… replacements=1)` followed by the raw unified diff),
      // NOT as JSON. When JSON parsing fails, recover the diff body by
      // slicing from the first real diff marker so the DiffBlock renders
      // instead of falling back to a flat plain-text view.
      diff = extractUnifiedDiffText(text);
    }
  } else if (toolName === 'patch') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      diff =
        stringOf((parsed as Record<string, unknown>)['diff']) ??
        stringOf((parsed as Record<string, unknown>)['stdout']);
    } else if (text.includes('@@') || text.startsWith('---')) {
      diff = text;
    }
  } else if (toolName === 'replace') {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      diff = joinReplaceDiffs(parsed as Record<string, unknown>);
    }
  }

  if (!diff?.trim() || diff.startsWith('(no-op')) return undefined;
  const preview = parseUnifiedDiff(diff, DIFF_MAX_LINES);
  return preview.rows.length > 0 ? preview : undefined;
}

/**
 * Pull one diff preview per file from a `replace` tool result. Each entry
 * has a `path` (best-effort: `results[i].path`, falling back to the input
 * argument when every result is for the same file) and a `preview` ready
 * for `DiffFileBlock` / `DiffBlock` rendering.
 *
 * Returns `undefined` when no per-file diff is recoverable (e.g. an empty
 * `results` array, no diff fields, or the result isn't a JSON object).
 *
 * Note: For a single entry point that handles `replace`, `diff`, and
 * `patch` (the three tools whose output can span multiple files), use
 * {@link extractMultiFileDiffs} instead — this function is kept for the
 * narrower replace-specific test cases.
 */
export function extractReplaceDiffs(
  toolName: string,
  output: string | undefined,
  input?: unknown | undefined,
): DiffFilePreviews | undefined {
  if (toolName !== 'replace') return undefined;
  return extractMultiFileDiffs(toolName, output, input);
}

/**
 * Pull a list of per-file diffs from a tool result that may span multiple
 * files. Handles:
 *
 * - `replace`: JSON `{ results: [{ path, diff }, …] }` (path per result,
 *   fallback to the input path when the result omits one).
 * - `diff`: JSON `{ diff: string }` where `diff` is a git-style multi-file
 *   unified diff (split on `diff --git` headers).
 * - `patch`: either JSON `{ diff: string, files: string[] }` or a raw
 *   unified-diff string (split on `diff --git` headers, falling back to
 *   `--- a/<path>` if no `diff --git` is present).
 *
 * Returns `undefined` when the tool isn't multi-file capable, the output
 * is missing/unparseable, or no per-file diff is recoverable. Returns an
 * empty array (not undefined) when the output parses but every entry has
 * an empty diff after trimming — the caller treats both as "nothing to
 * render" but the distinction is useful in tests.
 */
export function extractMultiFileDiffs(
  toolName: string,
  output: string | undefined,
  input?: unknown | undefined,
): DiffFilePreviews | undefined {
  if (!output) return undefined;
  const items = collectMultiFileDiffItems(toolName, output, input);
  if (items === undefined) return undefined;
  if (items.length === 0) return undefined;

  const previews: DiffFilePreviews = [];
  const candidateItems = items.slice(0, MULTI_DIFF_MAX_FILES);
  let remainingRows = MULTI_DIFF_MAX_ROWS;
  let visited = 0;
  for (const item of candidateItems) {
    if (remainingRows <= 0) break;
    visited++;
    const preview = parseUnifiedDiff(item.diff, Math.min(DIFF_MAX_LINES, remainingRows));
    if (preview.rows.length === 0) continue;
    previews.push({ path: item.path ?? 'unknown file', preview });
    remainingRows -= preview.rows.length;
  }
  const omittedItems = items.slice(visited);
  if (omittedItems.length > 0) {
    let added = 0;
    let removed = 0;
    for (const item of omittedItems) {
      const summary = countUnifiedDiffChanges(item.diff);
      added += summary.added;
      removed += summary.removed;
    }
    previews.omitted = { fileCount: omittedItems.length, added, removed };
  }
  return previews.length > 0 ? previews : undefined;
}

/**
 * Syntax-highlighted code / diff block.
 *
 * Memoized: highlighting is the single most expensive thing in the transcript,
 * and a completed fence never changes again while later text streams in.
 */
export const CodeBlock = memo(CodeBlockImpl);
