import { describe, expect, it } from 'vitest';
import { shouldAutoCollapse } from '../../src/components/ChatView/auto-collapse';

/**
 * Unit tests for the chat-input auto-collapse decision state machine.
 * The function is pure: it takes the current values plus the previous
 * render's values and returns whether the input should collapse. It must
 * fire ONLY on transitions (0→N transcript arrival, session switch,
 * pref flip false→true with history) — never on steady state or plain
 * message growth.
 */
describe('shouldAutoCollapse', () => {
  it('does not collapse when the pref is off (default behavior)', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: false,
        sessionChanged: false,
        prevHadMessages: false,
        prevAutoCollapse: false,
      }),
    ).toBe(false);
  });

  it('does not collapse when there is no history yet', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: false,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: false,
        prevAutoCollapse: true,
      }),
    ).toBe(false);
  });

  it('collapses on 0→N transcript arrival while the pref is on (fresh connect)', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: false,
        prevAutoCollapse: true,
      }),
    ).toBe(true);
  });

  it('collapses when the pref flips false→true while history is present', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: true,
        prevAutoCollapse: false,
      }),
    ).toBe(true);
  });

  it('collapses on a session switch while the pref is on and the new transcript has messages', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: true,
        prevHadMessages: true,
        prevAutoCollapse: true,
      }),
    ).toBe(true);
  });

  it('does NOT collapse on a session switch when the pref is off', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: false,
        sessionChanged: true,
        prevHadMessages: true,
        prevAutoCollapse: false,
      }),
    ).toBe(false);
  });

  it('does NOT collapse on a session switch when the new session has no history', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: false,
        autoCollapseInput: true,
        sessionChanged: true,
        prevHadMessages: false,
        prevAutoCollapse: true,
      }),
    ).toBe(false);
  });

  it('does NOT collapse on plain message growth after history exists', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: true,
        prevAutoCollapse: true,
      }),
    ).toBe(false);
  });

  it('does NOT collapse when both history and the pref were already active (mount with history)', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: true,
        prevAutoCollapse: true,
      }),
    ).toBe(false);
  });

  it('does NOT collapse when the pref flips while there is no history', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: false,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: false,
        prevAutoCollapse: false,
      }),
    ).toBe(false);
  });

  it('does NOT collapse when history is present but the pref was flipped OFF', () => {
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: false,
        sessionChanged: false,
        prevHadMessages: true,
        prevAutoCollapse: true,
      }),
    ).toBe(false);
  });

  it('collapses again when the user re-enables the pref after disabling it (false→true flip)', () => {
    // pref was ON → user turned it OFF (prevAutoCollapse false) → turns it
    // back ON while history is still present → collapse.
    expect(
      shouldAutoCollapse({
        hasMessages: true,
        autoCollapseInput: true,
        sessionChanged: false,
        prevHadMessages: true,
        prevAutoCollapse: false,
      }),
    ).toBe(true);
  });

  it('is deterministic across all 16 combinations with sessionChanged=false — only the transition cells collapse', () => {
    const combos = [
      [false, false, false, false],
      [false, false, false, true],
      [false, false, true, false],
      [false, false, true, true],
      [false, true, false, false],
      [false, true, false, true],
      [false, true, true, false],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, false, true],
      [true, false, true, false],
      [true, false, true, true],
      [true, true, false, false],
      [true, true, false, true],
      [true, true, true, false],
      [true, true, true, true],
    ] as const;
    const collapsing = combos.filter(([hasMessages, pref, prevHad, prevPref]) =>
      shouldAutoCollapse({
        hasMessages,
        autoCollapseInput: pref,
        sessionChanged: false,
        prevHadMessages: prevHad,
        prevAutoCollapse: prevPref,
      }),
    );
    // Exactly the transition cells — collapse whenever the pref is on and
    // history exists and EITHER was just newly true. The
    // [true,true,false,false] cell (history arrival + pref flip in the same
    // commit) collapses too: both orderings converge to collapsed, so
    // collapsing in that commit is the consistent outcome.
    expect(collapsing).toEqual([
      [true, true, false, false], // both transitions in one commit
      [true, true, false, true], // 0→N arrival, pref on
      [true, true, true, false], // pref false→true, history present
    ]);
  });
});
