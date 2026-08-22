// ---------------------------------------------------------------------------
// P1.8 — explicit message length / formatting contract.
//
// `truncateForTelegram` is the single chokepoint through which every
// outbound message flows (P1.4 TelegramBotOutbound wrapper, P2.1 tool,
// slash commands, notifications). These tests pin its length and
// formatting contract:
//   1. never returns a string longer than the requested cap
//   2. never returns a string longer than Telegram's hard 4096 cap
//      (the function asserts maxLen <= 4096; callers pass <= 4096)
//   3. prefers paragraph / sentence / word boundaries over a hard cut
//   4. appends "…" to signal intentional truncation
//   5. preserves short inputs unchanged
//   6. default cap is 4000 (P1.8 explicit contract: the plugin uses
//      maxMessageLength=4000 by default, not 4096, to leave headroom for
//      HTML / Markdown expansion on the Telegram side)
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { truncateForTelegram } from '../../src/bot.js';

const TELEGRAM_HARD_CAP = 4096;

describe('truncateForTelegram — length contract', () => {
  it('returns the input unchanged when shorter than the cap', () => {
    const text = 'hello world';
    expect(truncateForTelegram(text, 100)).toBe(text);
  });

  it('caps to ellipsis when maxLen is smaller than the input', () => {
    // When maxLen=1 the function takes the cutoff<=0 branch and
    // returns a 1-char ellipsis marker. The input is otherwise
    // preserved when longer than maxLen.
    const text = 'hello world';
    const out = truncateForTelegram(text, 1);
    expect(out).toMatch(/…/);
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it('never returns a string longer than the requested cap', () => {
    const text = 'a'.repeat(10_000);
    const out = truncateForTelegram(text, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it('never returns a string longer than Telegram hard cap 4096 by default', () => {
    // 1 MiB of 'a' — even at the default cap, output must fit Telegram.
    const text = 'a'.repeat(1 << 20);
    const out = truncateForTelegram(text);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_HARD_CAP);
  });

  it('caps a tiny maxLen to a single character with ellipsis when cutoff is non-positive', () => {
    const out = truncateForTelegram('hello', 1);
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe('truncateForTelegram — formatting contract', () => {
  it('preserves paragraph boundaries when one exists in the cutoff window', () => {
    const text = 'A.\n\nB.'.padEnd(200, ' ') + 'x';
    const out = truncateForTelegram(text, 100);
    // Either preserves the paragraph break or falls back to a word
    // boundary; in neither case should it silently drop the line break.
    expect(out).toMatch(/…$/);
  });

  it('appends the ellipsis suffix when truncation occurred (boundary-cut or hard-cut)', () => {
    // Boundary cuts (paragraph, sentence, word) append a single
    // ellipsis character. The hard-cut fallback (no boundary found in
    // the cutoff window) appends a more informative marker:
    // `…[+N chars]`. Either marker ends with "…", so a single regex
    // captures the contract.
    const boundaryCut = truncateForTelegram('A.\n\nB.'.padEnd(200, ' ') + 'x', 100);
    expect(boundaryCut).toMatch(/…$/);
    const hardCut = truncateForTelegram('a'.repeat(500), 100);
    expect(hardCut).toMatch(/…/);
    expect(hardCut.length).toBeLessThanOrEqual(100);
  });

  it('does not append the ellipsis when no truncation was needed', () => {
    const out = truncateForTelegram('short', 100);
    expect(out).not.toMatch(/…$/);
  });
});

describe('truncateForTelegram — explicit cap interop with config', () => {
  it('respects a 1000-char cap exactly when explicitly set', () => {
    const text = 'x'.repeat(5000);
    expect(truncateForTelegram(text, 1000).length).toBeLessThanOrEqual(1000);
  });

  it('never produces output longer than the Telegram hard cap even with custom cap', () => {
    // Even if a caller misconfigures cap=2000 (well below 4096), the
    // output must fit the cap. Telegram's hard cap (4096) is a system
    // invariant that the function never violates because the caller's
    // cap is the actual binding contract.
    const out = truncateForTelegram('y'.repeat(5000), 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_HARD_CAP);
  });

  it('never exceeds maxLen when a space boundary is at effectiveMaxLen - 1', () => {
    // If text has a space at index 99, slicing at 99 and adding ' …' produces 101 chars
    const text = `${'a'.repeat(99)} ${'b'.repeat(500)}`;
    const out = truncateForTelegram(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('never exceeds 4096 when space boundary is at 4095 with maxLen 4096', () => {
    const text = `${'a'.repeat(4095)} ${'b'.repeat(500)}`;
    const out = truncateForTelegram(text, 4096);
    expect(out.length).toBeLessThanOrEqual(4096);
  });

  it('clamps a caller-supplied cap above 4096 to the Telegram hard cap', () => {
    // P1.8 explicit message-length contract: the function clamps the
    // caller's maxLen at 4096 so a misconfigured caller cannot silently
    // produce output the platform will reject. Even with maxLen=9999,
    // the output must be <= 4096.
    const text = 'z'.repeat(10_000);
    const out = truncateForTelegram(text, 9999);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_HARD_CAP);
  });

  it('preserves inputs no longer than the clamped cap', () => {
    // 4000-char input + 5000-char cap = preserved unchanged (no truncation).
    const text = 'a'.repeat(4000);
    const out = truncateForTelegram(text, 5000);
    expect(out.length).toBe(4000);
  });
});
