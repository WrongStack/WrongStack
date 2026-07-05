import { render } from 'ink-testing-library';
import { createElement as e } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DIFF_MAX_LINES,
  DiffBlock,
  type DiffLineRow,
  extractDiffPreview,
  formatDiffStats,
  parseUnifiedDiff,
} from '../src/components/history/code-block.js';

function renderDiffBlock(
  rows: DiffLineRow[],
  opts: {
    useColor?: boolean;
    added?: number;
    removed?: number;
    hidden?: number;
    hiddenAdded?: number;
    hiddenRemoved?: number;
    lang?: 'ts' | 'plain';
    showStats?: boolean;
    contentWidth?: number;
  } = {},
): string {
  const { lastFrame, unmount } = render(
    e(DiffBlock, {
      rows,
      hidden: opts.hidden ?? 0,
      added: opts.added ?? 0,
      removed: opts.removed ?? 0,
      hiddenAdded: opts.hiddenAdded ?? 0,
      hiddenRemoved: opts.hiddenRemoved ?? 0,
      useColor: opts.useColor ?? false,
      lang: opts.lang ?? 'plain',
      showStats: opts.showStats ?? true,
      ...(opts.contentWidth !== undefined ? { contentWidth: opts.contentWidth } : {}),
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('formatDiffStats', () => {
  it('renders both sides in Claude Code phrasing', () => {
    expect(formatDiffStats(2, 2)).toBe('Added 2 lines, removed 2 lines');
    expect(formatDiffStats(1, 3)).toBe('Added 1 line, removed 3 lines');
  });

  it('omits the zero side and capitalizes the first word', () => {
    expect(formatDiffStats(7, 0)).toBe('Added 7 lines');
    expect(formatDiffStats(0, 1)).toBe('Removed 1 line');
  });

  it('returns null when nothing changed', () => {
    expect(formatDiffStats(0, 0)).toBeNull();
  });
});

describe('<DiffBlock /> rendering', () => {
  const rows: DiffLineRow[] = [
    { kind: 'hunk', text: '@@ -1 +1 @@' },
    { kind: 'del', text: '-old line', oldLine: 1 },
    { kind: 'add', text: '+new line', newLine: 1 },
    { kind: 'ctx', text: ' unchanged', oldLine: 2, newLine: 2 },
  ];

  it('renders the + and - markers for added and removed lines (no-color mode)', () => {
    const frame = renderDiffBlock(rows);
    expect(frame).toContain('+');
    expect(frame).toContain('-');
    expect(frame).toContain('new line');
    expect(frame).toContain('old line');
  });

  it('hides the leading hunk header (line numbers carry position)', () => {
    const frame = renderDiffBlock(rows);
    expect(frame).not.toContain('@@');
  });

  it('renders a dim ⋯ separator between hunks (not before the first)', () => {
    const twoHunks: DiffLineRow[] = [
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: '-old line', oldLine: 1 },
      { kind: 'hunk', text: '@@ -10 +10 @@' },
      { kind: 'add', text: '+new line', newLine: 10 },
    ];
    const frame = renderDiffBlock(twoHunks);
    expect(frame).not.toContain('@@');
    expect(frame.split('⋯').length - 1).toBe(1);
  });

  it('renders a single line-number column — old line for del, new line for add', () => {
    const frame = renderDiffBlock([
      { kind: 'del', text: '-old line', oldLine: 125 },
      { kind: 'add', text: '+new line', newLine: 125 },
      { kind: 'ctx', text: ' unchanged', oldLine: 126, newLine: 126 },
    ]);
    expect(frame).toMatch(/125 - old line/);
    expect(frame).toMatch(/125 \+ new line/);
    expect(frame).toMatch(/126 {3}unchanged/);
    // No dual gutter: "125 125" must not appear.
    expect(frame).not.toMatch(/125\s+125/);
  });

  it('renders no stats line when there are zero totals and no hidden lines', () => {
    const frame = renderDiffBlock(rows, {});
    expect(frame).not.toContain('more line');
    expect(frame).not.toContain('Added');
    expect(frame).not.toContain('removed');
  });

  it('renders an always-visible stats line with Added/removed totals (no truncation)', () => {
    // Even when the whole diff fits on screen (hidden=0), the totals
    // must surface so the change size is readable at a glance.
    const frame = renderDiffBlock(rows, { added: 7, removed: 3 });
    expect(frame).toContain('⎿');
    expect(frame).toContain('Added 7 lines, removed 3 lines');
    // No truncation note when nothing is hidden.
    expect(frame).not.toContain('more line');
  });

  it('suppresses the stats line when showStats=false (caller prints its own)', () => {
    const frame = renderDiffBlock(rows, { added: 7, removed: 3, showStats: false });
    expect(frame).not.toContain('Added 7 lines');
    expect(frame).not.toContain('⎿');
    // Body still renders.
    expect(frame).toContain('new line');
  });

  it('renders hidden-line footer when caller passes hidden > 0', () => {
    // DiffBlock still prints a `… +N -M hidden` footer whenever the
    // caller reports `hidden > 0`. The Update tool's default path
    // (extractDiffPreview → parseUnifiedDiff) no longer slices the
    // diff, so the footer stays suppressed there; but the rendering
    // path itself is unchanged and any caller that explicitly passes
    // `hidden` (e.g. a future cap-aware call site) still gets the
    // truncation note. This test pins that contract — drop the footer
    // rendering only after every truncation-aware caller is gone.
    const many: DiffLineRow[] = [
      { kind: 'hunk', text: '@@ -1,30 +1,30 @@' },
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: 'add' as const,
        text: `+added line ${i}`,
        newLine: i + 1,
      })),
      { kind: 'add', text: '+more', newLine: 13 },
    ];
    // Caller (parseUnifiedDiff) is responsible for slicing the rows
    // AND for reporting `hidden` + `hiddenAdded`/`hiddenRemoved` and the
    // overall `added`/`removed` totals separately. Pass them in here so
    // both the stats line and the truncation note have data to print.
    const { lastFrame, unmount } = render(
      e(DiffBlock, {
        rows: many,
        hidden: 5,
        added: 16,
        removed: 0,
        hiddenAdded: 4,
        hiddenRemoved: 1,
        useColor: false,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('…');
    expect(frame).toContain('more line');
    // Total additions surfaced by the stats line.
    expect(frame).toContain('Added 16 lines');
    // Hidden breakdown (+4 / -1) carried by the truncation note.
    expect(frame).toMatch(/\+4\b/);
    expect(frame).toMatch(/-1\b/);
  });

  it('omits the hidden footer when hidden = 0 (default extractDiffPreview path)', () => {
    // Regression for the `DIFF_MAX_LINES = Infinity` change: the
    // default Update tool path now reports `hidden = 0` for any diff,
    // so the footer is suppressed and every row renders. A 16-row add
    // is enough to prove "all rows shown, no truncation note".
    const rows: DiffLineRow[] = [
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      ...Array.from({ length: 16 }, (_, i) => ({
        kind: 'add' as const,
        text: `+added line ${i}`,
        newLine: i + 1,
      })),
    ];
    const frame = renderDiffBlock(rows, {
      added: 16,
      removed: 0,
      hidden: 0,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      useColor: false,
    });
    expect(frame).not.toContain('more line');
    expect(frame).not.toContain('hidden');
    // Every added line is present in the rendered output.
    for (let i = 0; i < 16; i++) {
      expect(frame).toContain(`added line ${i}`);
    }
  });

  it('renders the + marker with bold styling (no-color fallback)', () => {
    // In `useColor=false` mode the diff still distinguishes added vs
    // removed via the bold marker — the marker character + bold flag
    // are always emitted, only the wash is optional.
    const frame = renderDiffBlock([
      { kind: 'del', text: '-old', oldLine: 1 },
      { kind: 'add', text: '+new', newLine: 1 },
    ]);
    expect(frame).toContain('-');
    expect(frame).toContain('+');
    expect(frame).toContain('old');
    expect(frame).toContain('new');
  });

  it('useColor=true renders content lines with the same body (visual parity)', () => {
    // The structural difference between useColor=true and useColor=false
    // is the background wash on add/del lines. The actual text content
    // (markers + body) must be identical regardless — otherwise users
    // would see different diffs based on terminal capability.
    const withoutColor = renderDiffBlock(
      [
        { kind: 'del', text: '-old line', oldLine: 1 },
        { kind: 'add', text: '+new line', newLine: 1 },
      ],
      { useColor: false },
    );
    const withColor = renderDiffBlock(
      [
        { kind: 'del', text: '-old line', oldLine: 1 },
        { kind: 'add', text: '+new line', newLine: 1 },
      ],
      { useColor: true },
    );
    // Strip whitespace and compare the textual content (ink-testing-library
    // strips ANSI escapes from lastFrame, so both should be plain text).
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalize(withoutColor)).toBe(normalize(withColor));
  });

  it('hard-wraps a long line onto continuation rows instead of mid-line truncating', () => {
    // A body far wider than the content budget must render in FULL — the
    // ellipsis (…) truncation that used to cut the row is gone; the whole
    // line survives, split across continuation rows.
    const longWord = 'x'.repeat(200);
    const frame = renderDiffBlock([{ kind: 'add', text: `+${longWord}`, newLine: 1 }], {
      contentWidth: 60,
    });
    // The full 200-char run is present (wrapping only inserts continuation
    // indent whitespace, never drops characters — strip all whitespace to
    // reconstruct the original body).
    const joined = frame.replace(/\s+/g, '');
    expect(joined).toContain(longWord);
    // No ellipsis marker — nothing was truncated.
    expect(frame).not.toContain('…');
    // It actually wrapped: more than one visual row carries the x-run.
    expect(frame.split('\n').filter((l) => l.includes('x')).length).toBeGreaterThan(1);
  });

  it('preserves a full long line even with no contentWidth (fallback wrap budget)', () => {
    const longWord = 'y'.repeat(160);
    const frame = renderDiffBlock([{ kind: 'add', text: `+${longWord}`, newLine: 1 }]);
    const joined = frame.replace(/\s+/g, '');
    expect(joined).toContain(longWord);
    expect(frame).not.toContain('…');
  });

  it('renders the full changed-line body at a known content width (no truncation)', () => {
    // With a known contentWidth the changed-line body renders in full — the
    // wash pads it out to the content edge with trailing spaces (verified in
    // a real terminal; ink-testing-library strips ANSI + trailing whitespace
    // so the pad itself isn't visible here). The body must survive intact
    // regardless.
    const body = 'const className = "flex gap-3 animate-pulse rounded-2xl px-3 py-2";';
    const frame = renderDiffBlock([{ kind: 'del', text: `-${body}`, oldLine: 17 }], {
      useColor: true,
      contentWidth: 120,
      removed: 1,
      lang: 'ts',
    });
    expect(frame.replace(/\s+/g, ' ')).toContain(body);
    expect(frame).not.toContain('…');
    expect(frame).toMatch(/17 -/);
  });

  it('parseUnifiedDiff default cap is unbounded (Update tool renders every row)', () => {
    // The default Update tool path (extractDiffPreview → parseUnifiedDiff)
    // must surface every diff row, no matter how large, so a long edit is
    // legible instead of silently truncated. Pin the contract: a 50-line
    // add returns 50 rows (plus the leading hunk header — counted as a
    // `hunk` row, not an add), hidden = 0, totals match. Also assert the
    // exported `DIFF_MAX_LINES` constant itself, so a future refactor that
    // accidentally re-introduces a cap fails this test loudly.
    expect(Number.isFinite(DIFF_MAX_LINES)).toBe(false);

    const lines = Array.from({ length: 50 }, (_, i) => `+added line ${i}`);
    const diff = `@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}`;
    const preview = parseUnifiedDiff(diff, DIFF_MAX_LINES);
    // 1 hunk + 50 adds
    expect(preview.rows.length).toBe(51);
    expect(preview.hidden).toBe(0);
    expect(preview.hiddenAdded).toBe(0);
    expect(preview.hiddenRemoved).toBe(0);
    expect(preview.added).toBe(50);
    expect(preview.removed).toBe(0);

    // Same path the Update tool takes. Output is non-empty so extractDiffPreview
    // returns a DiffPreview (not undefined) and every line is in the rows.
    const extracted = extractDiffPreview('edit', JSON.stringify({ diff }));
    expect(extracted).toBeDefined();
    expect(extracted?.rows.length).toBe(51);
    expect(extracted?.hidden).toBe(0);
  });

  it('syntax highlighting is length-preserving — body text unchanged under lang=ts', () => {
    const plain = renderDiffBlock([{ kind: 'add', text: '+const x = "hi"; // note', newLine: 1 }], {
      lang: 'plain',
    });
    const highlighted = renderDiffBlock(
      [{ kind: 'add', text: '+const x = "hi"; // note', newLine: 1 }],
      { lang: 'ts' },
    );
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalize(highlighted)).toBe(normalize(plain));
    expect(highlighted).toContain('const x = "hi"; // note');
  });

  it('wash mode keeps the comment text intact (contrast override does not drop glyphs)', () => {
    // Regression for the comment-color override on the diff wash: the
    // override only swaps the foreground/dim bits on comment tokens, so
    // the rendered text width must stay identical between the useColor
    // wash path and the no-color fallback. ink-testing-library strips
    // ANSI escapes from `lastFrame`, so we can compare textual parity.
    const body = '+const x = "hi"; // note';
    const withoutColor = renderDiffBlock([{ kind: 'add', text: body, newLine: 1 }], {
      useColor: false,
      lang: 'ts',
    });
    const withColor = renderDiffBlock([{ kind: 'add', text: body, newLine: 1 }], {
      useColor: true,
      lang: 'ts',
    });
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalize(withColor)).toBe(normalize(withoutColor));
    expect(withColor).toContain('// note');
  });
});
