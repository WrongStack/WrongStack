import type React from 'react';
import {
  type HLState,
  highlightLine,
  type Lang,
  langFromPath,
  type Token,
} from '../../highlight.js';
import { Box, Text } from '../../ink.js';
import { theme } from '../../theme.js';
import { stringOf, truncMid, tryParseJson } from './utils.js';

// ── Types ──

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx' | 'meta';

export interface DiffLineRow {
  kind: DiffLineKind;
  text: string;
  oldLine?: number | undefined;
  newLine?: number | undefined;
}

export interface DiffPreview {
  rows: DiffLineRow[];
  hidden: number;
  added: number;
  removed: number;
  hiddenAdded: number;
  hiddenRemoved: number;
}

/**
 * A parsed diff paired with the file it belongs to. Used when a tool
 * produces diffs for several files at once (currently `replace`); each
 * `DiffFilePreview` renders as one labeled `DiffFileBlock`.
 */
export interface DiffFilePreview {
  path: string;
  preview: DiffPreview;
}

// ── Constants ──

/** Max code-block lines rendered before a "+N more" footer. */
export const MAX_CODE_LINES = 80;
/**
 * Default cap on rows surfaced by {@link parseUnifiedDiff} for the main
 * Update tool diff view. Previously hardcoded to `12`, which silently
 * truncated larger diffs and pushed the rest into a `… +N -M hidden`
 * footer. The Update tool runs in a scrollable history surface, so a
 * long diff is a legitimate read — let it render in full. Callers that
 * still need a hard cap (e.g. the approval dialog's tighter box) pass
 * their own number explicitly to `parseUnifiedDiff`; this default is
 * for the unbounded read-everything path.
 *
 * Set to `Number.POSITIVE_INFINITY` so `parseUnifiedDiff`'s `if (all.length
 * <= maxLines)` branch always matches and the slice/footer machinery
 * becomes a no-op. The `DIFF_LINE_SAFETY_CAP` below still bounds
 * individual row text length, which protects against pathological
 * one-liners (minified bundles, huge JSON blobs).
 */
export const DIFF_MAX_LINES = Number.POSITIVE_INFINITY;
/**
 * Safety cap on a single diff row's stored text. Diff rows render at full
 * length (wrapped onto continuation rows, never mid-line truncated), so this
 * only guards against pathological one-line files (minified bundles, huge
 * JSON blobs) flooding the screen — never real code lines.
 */
const DIFF_LINE_SAFETY_CAP = 4000;
/**
 * Wrap budget when the caller doesn't supply `contentWidth` (e.g. the
 * approval dialog). Matches the historical per-row cap so the layout risk
 * on narrow terminals is unchanged — but the content wraps instead of
 * being cut off.
 */
const DIFF_FALLBACK_WRAP_WIDTH = 100;

// ── CodeBlock ──

/** Syntax-highlighted, framed code block. */
export function CodeBlock({
  code,
  lang,
  contentWidth,
}: {
  code: string;
  lang: Lang;
  contentWidth: number;
}): React.ReactElement {
  let lines = code.replace(/\n+$/, '').split('\n');
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
  const boxWidth = Math.max(22, contentWidth - 2);
  // Text area inside the frame: box width − border(2) − paddingX(2) − gutter.
  const maxW = Math.max(20, Math.min(boxWidth - 4 - gutterW - 1, 120));
  let carry: HLState = {};
  const rows = lines.map((raw) => {
    const display = raw.length > maxW ? `${raw.slice(0, maxW - 1)}…` : raw;
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
  /** Number of files whose preview was truncated by the per-file cap. */
  truncatedFiles: number;
}

/**
 * Sum the totals of a list of per-file diff previews. Files that were
 * parsed but have no rows (e.g. entirely empty after the no-op skip) are
 * excluded from the rollup so the summary reflects what the user will
 * actually see rendered below.
 */
export function summarizeMultiFileDiffs(items: DiffFilePreview[]): MultiDiffSummary {
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
  return {
    fileCount: items.length,
    added,
    removed,
    hiddenAdded,
    hiddenRemoved,
    truncatedFiles,
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
 * plain-background rendering keeps the conventional dim/gray comment
 * look and there is no contrast reason to intervene.
 *
 * When `onWash` is true, comment tokens (color `gray`, conventionally
 * `dim: true`) are promoted to a brighter foreground (`grayBright`) and
 * lose their dim flag. The diff wash is dark enough that `dim gray`
 * (`pastel.gray`) falls below WCAG AA contrast on either `theme.diffAddBg`
 * (ratio ≈ 2.91) or `theme.diffDelBg` (ratio ≈ 3.47) and reads as near-
 * invisible noise; `grayBright` clears both wash backgrounds (≥ 4.5) and
 * keeps the comment visually secondary without becoming unreadable.
 * Non-comment tokens pass through unchanged so the rest of the line keeps
 * its existing syntax palette on the wash.
 *
 * Exported for unit testing — `renderTokens` calls it before mapping to
 * `<Text>` elements so the override logic itself stays a pure function.
 */
export function applyWashTokens(tokens: Token[], onWash: boolean): Token[] {
  if (!onWash) return tokens;
  return tokens.map((t) => {
    if (t.color !== 'gray') return t;
    return { ...t, color: 'grayBright', dim: false };
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
  let currentLen = 0;
  for (const t of tokens) {
    let text = t.text;
    while (text.length > 0) {
      const room = width - currentLen;
      if (room <= 0) {
        segments.push(current);
        current = [];
        currentLen = 0;
        continue;
      }
      const piece = text.slice(0, room);
      current.push({ ...t, text: piece });
      currentLen += piece.length;
      text = text.slice(piece.length);
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
    if ((row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx') && row.text.length > 0) {
      return row.text.slice(1) || ' ';
    }
    return row.text || ' ';
  };

  const stats = showStats ? formatDiffStats(added, removed) : null;

  // Row anatomy: box margin (2) + `   ` prefix (3) + line number + ` X `
  // marker cell (3). Whatever remains is the per-segment wrap budget.
  const bodyBudget =
    typeof contentWidth === 'number'
      ? Math.max(16, contentWidth - (2 + 3 + gutterWidth + 3))
      : DIFF_FALLBACK_WRAP_WIDTH;
  // When the width is known, the add/del wash pads its body out to the full
  // `bodyBudget` with trailing spaces so the dark green/maroon background
  // spans the whole line — right up to the content edge — instead of
  // stopping at the end of the (often short) text. This is required because
  // Ink only paints a background behind actual characters (a `<Text
  // backgroundColor>` colours its trailing spaces; a `<Box backgroundColor>`
  // does NOT fill the empty area), so the wash needs real padding chars to
  // reach the edge. The approval-dialog path (no contentWidth) skips the
  // padding to avoid over-wide rows in the bordered confirm box.
  const hasWidth = typeof contentWidth === 'number';
  const padBody = (seg: Token[]): number => {
    if (!hasWidth) return 0;
    const len = seg.reduce((n, t) => n + t.text.length, 0);
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
              {`   ${blank}   ${row.text}`}
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

export function parseUnifiedDiff(diff: string, maxLines: number): DiffPreview {
  const all: DiffLineRow[] = [];
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) {
        oldLn = Number.parseInt(m[1] ?? '0', 10) || 0;
        newLn = Number.parseInt(m[2] ?? '0', 10) || 0;
      }
      all.push({ kind: 'hunk', text: truncMid(line, 60) });
      continue;
    }
    if (line.startsWith('+')) {
      all.push({ kind: 'add', text: truncMid(line, DIFF_LINE_SAFETY_CAP), newLine: newLn });
      newLn++;
      continue;
    }
    if (line.startsWith('-')) {
      all.push({ kind: 'del', text: truncMid(line, DIFF_LINE_SAFETY_CAP), oldLine: oldLn });
      oldLn++;
      continue;
    }
    if (line.startsWith('\\ No newline')) {
      all.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.length === 0) continue;
    all.push({
      kind: 'ctx',
      text: truncMid(line, DIFF_LINE_SAFETY_CAP),
      oldLine: oldLn,
      newLine: newLn,
    });
    oldLn++;
    newLn++;
  }
  const added = all.filter((row) => row.kind === 'add').length;
  const removed = all.filter((row) => row.kind === 'del').length;
  if (all.length === 0) {
    return { rows: [], hidden: 0, added: 0, removed: 0, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  if (all.length <= maxLines) {
    return { rows: all, hidden: 0, added, removed, hiddenAdded: 0, hiddenRemoved: 0 };
  }
  const rows = all.slice(0, maxLines);
  const hiddenRows = all.slice(maxLines);
  return {
    rows,
    hidden: hiddenRows.length,
    added,
    removed,
    hiddenAdded: hiddenRows.filter((row) => row.kind === 'add').length,
    hiddenRemoved: hiddenRows.filter((row) => row.kind === 'del').length,
  };
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

function joinReplaceDiffs(obj: Record<string, unknown>): string | undefined {
  const items = splitReplaceDiffs(obj);
  const diffs = items.map((item) => item.diff);
  return diffs.length > 0 ? diffs.join('\n') : undefined;
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
): DiffFilePreview[] | undefined {
  if (toolName !== 'replace') return undefined;
  return extractMultiFileDiffs(toolName, output, input);
}

interface ReplaceDiffItem {
  path?: string | undefined;
  diff: string;
}

function splitReplaceDiffs(obj: Record<string, unknown>): ReplaceDiffItem[] {
  const results = Array.isArray(obj['results']) ? (obj['results'] as unknown[]) : [];
  const items: ReplaceDiffItem[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const record = result as Record<string, unknown>;
    const diff = stringOf(record['diff']);
    if (!diff?.trim()) continue;
    const path = stringOf(record['path']);
    items.push(path ? { path, diff } : { diff });
  }
  return items;
}

interface PathedDiffItem {
  path?: string | undefined;
  diff: string;
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
): DiffFilePreview[] | undefined {
  if (!output) return undefined;
  const items = collectMultiFileDiffItems(toolName, output, input);
  if (items === undefined) return undefined;
  if (items.length === 0) return undefined;

  const previews: DiffFilePreview[] = [];
  for (const item of items) {
    const preview = parseUnifiedDiff(item.diff, DIFF_MAX_LINES);
    if (preview.rows.length === 0) continue;
    previews.push({ path: item.path ?? 'unknown file', preview });
  }
  return previews.length > 0 ? previews : undefined;
}

function collectMultiFileDiffItems(
  toolName: string,
  output: string,
  // `input` is reserved for future per-tool fallbacks (e.g. `replace` paths
  // derived from the input shape). The current dispatch derives paths from
  // the tool output itself (`files: string[]` from `diff`/`patch`,
  // `results[i].path` from `replace`, header lines from raw patches), so the
  // parameter is intentionally unused here. Marking it `_input` keeps the
  // surface stable for callers without triggering TS6133.
  _input?: unknown | undefined,
): PathedDiffItem[] | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;

  if (toolName === 'replace') {
    const parsed = tryParseJson(trimmed);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const items = splitReplaceDiffs(parsed as Record<string, unknown>);
    if (items.length === 0) return items;
    // Fallback: if every result omitted its own path, use the input's
    // `path` argument as the shared label (matches the previous
    // `extractReplaceDiffs` behaviour).
    const allMissing = items.every((item) => !item.path);
    const fallback =
      allMissing &&
      _input &&
      typeof _input === 'object' &&
      typeof (_input as Record<string, unknown>)['path'] === 'string'
        ? stringOf((_input as Record<string, unknown>)['path'])
        : undefined;
    if (fallback) {
      return items.map((item) => ({ path: item.path ?? fallback, diff: item.diff }));
    }
    return items;
  }

  if (toolName === 'diff') {
    const parsed = tryParseJson(trimmed);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const files = Array.isArray(obj['files'])
        ? (obj['files'] as unknown[]).map(stringOf).filter((p): p is string => Boolean(p))
        : [];
      const diff = stringOf(obj['diff']) ?? stringOf(obj['stdout']);
      if (!diff?.trim()) return undefined;
      // If `files` is populated, pair it with the (possibly multi-file)
      // diff by splitting the diff on `diff --git` headers and using the
      // `files` list as the preferred path source (left-to-right). When
      // the lengths disagree (e.g. empty `files`, or a diff that contains
      // more blocks than the count suggests), fall back to the path parsed
      // from the diff headers.
      const blocks = splitGitStyleDiff(diff);
      return blocks.map((block, idx) => ({
        path: files[idx] ?? block.path,
        diff: block.diff,
      }));
    }
    // Non-JSON `diff` output — treat the whole blob as one block, no path.
    if (trimmed.includes('@@')) return [{ diff: trimmed }];
    return undefined;
  }

  if (toolName === 'patch') {
    const parsed = tryParseJson(trimmed);
    let diffText: string | undefined;
    let explicitFiles: string[] = [];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      diffText = stringOf(obj['diff']) ?? stringOf(obj['stdout']);
      if (Array.isArray(obj['files'])) {
        explicitFiles = (obj['files'] as unknown[])
          .map(stringOf)
          .filter((p): p is string => Boolean(p));
      }
    } else if (trimmed.includes('@@') || trimmed.startsWith('---')) {
      diffText = trimmed;
    }
    if (!diffText?.trim()) return undefined;
    const blocks = splitGitStyleDiff(diffText);
    if (blocks.length === 0) {
      // A patch with no `diff --git` headers but valid `---`/`+++`
      // headers is single-file — wrap it as one block, taking the path
      // from the explicit `files` array if available.
      const path = explicitFiles[0] ?? extractPatchHeaderPath(diffText);
      return [{ path, diff: diffText }];
    }
    return blocks.map((block, idx) => ({
      path: explicitFiles[idx] ?? block.path,
      diff: block.diff,
    }));
  }

  return undefined;
}

interface DiffBlockSplit {
  path?: string | undefined;
  diff: string;
}

/**
 * Split a concatenated git-style unified diff into per-file blocks.
 * Recognises both `diff --git a/<path> b/<path>` headers (the modern git
 * format, also produced by `git diff` and `git format-patch`) and the
 * older `--- a/<path> / +++ b/<path>` pair as a fallback when no
 * `diff --git` line is present. Returns an empty array if the input
 * doesn't look like a unified diff at all.
 */
function splitGitStyleDiff(diff: string): DiffBlockSplit[] {
  const lines = diff.split('\n');
  const blocks: DiffBlockSplit[] = [];
  let current: { path?: string | undefined; body: string[]; hasGitHeader: boolean } | null = null;

  const flush = (): void => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) blocks.push({ path: current.path, diff: text });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = { path: parseDiffGitPath(line), body: [line], hasGitHeader: true };
      continue;
    }
    if (current) {
      current.body.push(line);
      // Treat `--- a/` as a block boundary only when the current block
      // has no `diff --git` header (older patch(1) format). A modern
      // `git diff` block always starts with `diff --git` and contains
      // its own `--- a/` lines as part of the same hunk — splitting on
      // those would shred the block.
      if (!current.hasGitHeader && line.startsWith('--- a/') && current.body.length > 2) {
        const carriedBody = current.body.slice(0, -1);
        const carriedPath = current.path;
        const text = carriedBody.join('\n').trim();
        if (text) blocks.push({ path: carriedPath, diff: text });
        current = {
          path: line.slice('--- a/'.length).trim(),
          body: [line],
          hasGitHeader: false,
        };
      }
    } else if (line.startsWith('--- a/')) {
      current = { path: line.slice('--- a/'.length).trim(), body: [line], hasGitHeader: false };
    } else if (line.startsWith('+++ b/')) {
      // Lone +++ without a preceding --- — synthesise a block with no path.
      current = { body: [line], hasGitHeader: false };
    }
  }
  flush();

  // If we ended up with a single block and no path was parsed, try a
  // last-ditch read of the `+++ b/` line in the body.
  if (blocks.length === 1 && !blocks[0]!.path) {
    const path = extractPatchHeaderPath(blocks[0]!.diff);
    if (path) blocks[0] = { path, diff: blocks[0]!.diff };
  }

  return blocks;
}

function parseDiffGitPath(line: string): string | undefined {
  // `diff --git a/<path> b/<path>` — handle paths-with-spaces by splitting
  // on ` b/` from the right when possible, falling back to the simpler
  // split when there's no ambiguity.
  const rest = line.slice('diff --git '.length).trim();
  if (!rest) return undefined;
  const sep = rest.lastIndexOf(' b/');
  if (sep > 0 && sep > rest.length - sep - 3) {
    return rest.slice(sep + 3);
  }
  // Fallback: take the right-hand token after the last space, stripping
  // the leading `b/`.
  const spaceIdx = rest.lastIndexOf(' ');
  if (spaceIdx > 0) {
    const rhs = rest.slice(spaceIdx + 1);
    return rhs.startsWith('b/') ? rhs.slice(2) : rhs;
  }
  return undefined;
}

function extractPatchHeaderPath(diffText: string): string | undefined {
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      // `+++ b/<path>` is the git convention; `+++ <path>` is the patch(1)
      // convention. Strip a leading `b/` and any trailing timestamp.
      const cleaned = path.replace(/^b\//, '').split('\t')[0]!.trim();
      return cleaned || undefined;
    }
  }
  return undefined;
}

/**
 * Recover the unified-diff body from a serialized tool-output string.
 *
 * The tool-output serializer renders edit/diff/write results as a header
 * line (e.g. `edit (path=… replacements=1)`) followed by the raw unified
 * diff. Feeding the whole string to `parseUnifiedDiff` would mis-read the
 * header as a context line and skew the hunk line counters, so we slice
 * from the first genuine diff marker (`--- `, `diff --git`, or `@@`).
 *
 * Returns `undefined` when no diff markers are present so callers keep
 * their existing plain-text fallback.
 */
function extractUnifiedDiffText(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) => line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@'),
  );
  if (start === -1) return undefined;
  return lines.slice(start).join('\n');
}

function newFileDiffFromWriteInput(
  output: Record<string, unknown>,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const content = stringOf(obj['content']);
  if (content === undefined) return undefined;
  const path = stringOf(output['path']) ?? stringOf(obj['path']) ?? 'new file';
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const header = [`+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`];
  return [...header, ...lines.map((line) => `+${line}`)].join('\n');
}
