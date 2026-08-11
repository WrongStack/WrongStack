import { describe, expect, it } from 'vitest';
import { applyWashTokens } from '../src/components/history/code-block.js';
import type { Token } from '../src/highlight.js';

/**
 * Unit tests for the diff-wash comment-foreground override. The DiffBlock
 * `useColor=true` path calls `renderTokens(seg, true)`, which delegates
 * to `applyWashTokens`. The override matters because `theme.diffAddBg` /
 * `theme.diffDelBg` are dark enough that the conventional comment
 * rendering (`syntax.comment` + `dim: true`) falls below WCAG AA contrast
 * on either wash — see `applyWashTokens` for the full rationale.
 *
 * These tests pin the override at the token layer because ink-testing-
 * library's mock terminal strips ANSI escapes from `lastFrame`, so the
 * wash-time color/dim decisions are not observable through the rendered
 * frame. Exercising the pure function is the only way to assert the
 * behavior stays correct.
 */
describe('applyWashTokens', () => {
  const comment = (text: string): Token => ({ text, color: 'syntax.comment', dim: true });
  const keyword = (text: string): Token => ({ text, color: 'syntax.keyword' });
  const plain = (text: string): Token => ({ text });

  it('returns the input unchanged when onWash is false', () => {
    // Plain-background render must keep the dim/gray comment look — the
    // contrast problem only exists on the dark diff washes.
    const tokens: Token[] = [keyword('const'), plain(' '), comment('// hello')];
    const out = applyWashTokens(tokens, false);
    // Same reference, no copy.
    expect(out).toBe(tokens);
    expect(out[2]).toEqual({ text: '// hello', color: 'syntax.comment', dim: true });
  });

  it('re-points a dim comment token to syntax.commentOnWash + dim=false on wash', () => {
    // The whole point: on the wash the comment must read as a brighter
    // foreground without the dim modifier, otherwise it disappears into
    // the dark green/maroon background.
    const tokens: Token[] = [comment('// hello comment')];
    const out = applyWashTokens(tokens, true);
    expect(out).toEqual([{ text: '// hello comment', color: 'syntax.commentOnWash', dim: false }]);
    // Length-preserving invariant from the highlighter must still hold
    // after the override — the line width never drifts.
    expect(out.map((t) => t.text).join('')).toBe('// hello comment');
  });

  it('passes non-comment tokens through unchanged on wash', () => {
    // Keywords, strings, identifiers, plain text — keep their colors so
    // the syntax palette on the wash matches the off-wash palette. Only
    // the comment is overridden.
    const tokens: Token[] = [
      keyword('const'),
      plain(' '),
      { text: "'x'", color: 'syntax.string' },
      plain('; '),
      comment('// hi'),
    ];
    const out = applyWashTokens(tokens, true);
    expect(out[0]).toBe(tokens[0]);
    expect(out[1]).toBe(tokens[1]);
    expect(out[2]).toBe(tokens[2]);
    expect(out[3]).toBe(tokens[3]);
    expect(out[4]).toEqual({ text: '// hi', color: 'syntax.commentOnWash', dim: false });
  });

  it('re-points any syntax.comment token regardless of its dim flag', () => {
    // Defensive: the role name alone is the comment signal — `dim` is not
    // consulted. A `syntax.comment` token with `dim: undefined` still flips,
    // because the role is by definition only emitted for comments. Pinning
    // the simple rule keeps a future caller from depending on `dim`.
    const tokens: Token[] = [{ text: 'x', color: 'syntax.comment', dim: undefined }];
    const out = applyWashTokens(tokens, true);
    expect(out[0]).toEqual({ text: 'x', color: 'syntax.commentOnWash', dim: false });
  });

  it('preserves the bold flag on a comment token when overriding', () => {
    // Highlighter doesn't bold comments today, but the override is a
    // pure property-rewrite (`...t`) — it must not silently drop future
    // flags the upstream token might carry.
    const tokens: Token[] = [{ text: '!', color: 'syntax.comment', dim: true, bold: true }];
    const out = applyWashTokens(tokens, true);
    expect(out[0]).toEqual({ text: '!', color: 'syntax.commentOnWash', dim: false, bold: true });
  });

  it('returns an empty list unchanged on wash', () => {
    expect(applyWashTokens([], true)).toEqual([]);
  });

  it('handles a realistic ts add line: const + string + comment on wash', () => {
    // Mirror the shape `highlightLine` produces for a ts add row.
    const tokens: Token[] = [
      keyword('const'),
      plain(' x '),
      { text: '= "hi"', color: 'syntax.string' },
      plain('; '),
      comment('// note'),
    ];
    const out = applyWashTokens(tokens, true);
    expect(out[0]).toEqual({ text: 'const', color: 'syntax.keyword' });
    expect(out[1]).toBe(tokens[1]);
    expect(out[2]).toBe(tokens[2]);
    expect(out[3]).toBe(tokens[3]);
    expect(out[4]).toEqual({ text: '// note', color: 'syntax.commentOnWash', dim: false });
    // The whole-line text is still the concatenation of token texts, so
    // downstream rendering width stays unchanged.
    expect(out.map((t) => t.text).join('')).toBe('const x = "hi"; // note');
  });
});
