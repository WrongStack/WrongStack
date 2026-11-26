import { describe, expect, it } from 'vitest';
import { withoutHiddenText } from '../src/features/inbox/hidden-text';

/**
 * A remote approval shows what an operator is blessing, including the exact
 * trust pattern a standing grant stores. ApprovalDetail renders from this
 * stripped copy: bidi overrides reorder that text and Tag characters hide
 * some of it, so neither may reach the view.
 */
const HIDDEN = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const TAG = String.fromCodePoint(0xe0041);

describe('approval hidden text', () => {
  it('drops bidi overrides and invisible text from every string, keys included', () => {
    const shown = withoutHiddenText({
      suggestedPattern: 'bash:cat notes‮*',
      inputSummary: { command: `cat notes‮txt.hs${TAG}`, [`k​y`]: [`a⁦b`] },
      writeTargets: ['r‮gnp.exe'],
      remainingMs: 120_000,
    });
    expect(JSON.stringify(shown)).not.toMatch(HIDDEN);
    expect(shown.inputSummary).toEqual({ command: 'cat notestxt.hs', ky: ['ab'] });
    expect(shown.writeTargets).toEqual(['rgnp.exe']);
    expect(shown.remainingMs).toBe(120_000);
  });

  it('keeps ordinary text', () => {
    expect(withoutHiddenText('echo café 日本 🚀')).toBe('echo café 日本 🚀');
    expect(withoutHiddenText(null)).toBeNull();
  });
});
