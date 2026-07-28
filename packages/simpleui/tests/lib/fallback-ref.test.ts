/**
 * Stub-contract tests for `packages/simpleui/src/lib/fallback-ref.ts`.
 *
 * As of 2026-07-28 the SimpleUI has no native fallback editor. The stub
 * exists so that when the editor lands, the cross-surface wording
 * contract is enforced from day one: every reason string returned by
 * this helper must match the WebUI helper in
 * `packages/webui/src/lib/fallback-ref.ts` AND the slash command's
 * `refInactiveReason` in `packages/cli/src/slash-commands/fallback.ts`.
 *
 * These tests pin the **stub behavior** today:
 *
 *   - The stub returns `undefined` for every input, so callers cannot
 *     get a real inactive verdict. This is the safe default while no
 *     SimpleUI fallback editor exists.
 *
 * When the helper is upgraded to a real implementation, replace these
 * assertions with the cross-surface wording tests (mirror
 * `packages/webui/tests/lib/fallback-ref.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { classifyRef, type RefActiveState, refInactiveReason } from '../../src/lib/fallback-ref';

describe('fallback-ref (SimpleUI stub contract)', () => {
  it('refInactiveReason always returns undefined in stub mode', () => {
    expect(refInactiveReason('anthropic/claude-opus-4', undefined)).toBeUndefined();
    expect(
      refInactiveReason('anthropic/claude-opus-4', new Set(['anthropic/claude-opus-4'])),
    ).toBeUndefined();
    // Even refs that would be inactive in the real helper stay undefined
    // until the stub is replaced with the cross-surface implementation.
    expect(refInactiveReason('ghost/some-model', new Set())).toBeUndefined();
    expect(refInactiveReason('', new Set(['anthropic/claude-opus-4']))).toBeUndefined();
  });

  it('classifyRef always returns active in stub mode', () => {
    const expected: RefActiveState = { active: true };
    expect(classifyRef('anthropic/claude-opus-4', undefined)).toEqual(expected);
    expect(classifyRef('ghost/some-model', new Set(['anthropic/claude-opus-4']))).toEqual(expected);
    expect(classifyRef('', undefined)).toEqual(expected);
  });

  // Forward-looking contract: when this stub is replaced with a real
  // implementation, the new helper must produce the same reason
  // strings as the WebUI helper and the slash command. The pinned
  // strings below are the authoritative wording — any change to
  // `refInactiveReason` in either surface must update all three.
  //
  // Commented out until a real editor is added; uncomment to enable the
  // cross-surface parity assertion once the SimpleUI fallback editor
  // exists.
  //
  // it('matches the cross-surface wording for inactive refs', () => {
  //   const known = new Set(['anthropic/claude-opus-4']);
  //   expect(refInactiveReason('anthropic/claude-99', known)).toBe(
  //     '"claude-99" not in anthropic model list',
  //   );
  //   expect(refInactiveReason('/claude-opus-4', known)).toBe(
  //     'no provider in reference',
  //   );
  //   expect(refInactiveReason('', known)).toBe('"" has no model');
  // });
});
