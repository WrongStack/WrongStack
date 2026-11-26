import { describe, expect, it } from 'vitest';
import {
  formatSubagentModelFailedText,
  shortenTaskPreview,
} from '../src/hooks/subagent-history-format.js';

const ROCKET = '\u{1F680}';

/**
 * F2636: the TUI history formatters cut model/error text and task previews with
 * a plain `.slice`, so a cut between the two units of an astral character
 * leaves a lone surrogate in the rendered line.
 */
describe('TUI history formatting keeps valid UTF-16 (F2636)', () => {
  it('drops the orphaned half in the model-failure line', () => {
    const text = formatSubagentModelFailedText(`${'m'.repeat(70)}${ROCKET}tail`);

    expect(text.isWellFormed()).toBe(true);
    expect(text).toContain('m'.repeat(70));
  });

  it('drops the orphaned half in a task preview', () => {
    const text = shortenTaskPreview(`${'t'.repeat(54)}${ROCKET}tail`, 56);

    expect(text.isWellFormed()).toBe(true);
    expect(text).toContain('t'.repeat(54));
  });

  it('keeps short values and boundary-safe emoji (control)', () => {
    expect(formatSubagentModelFailedText('provider refused')).toContain('provider refused');
    expect(shortenTaskPreview('short task')).toBe('short task');
    const safe = shortenTaskPreview(`${'t'.repeat(53)}${ROCKET}tail`, 56);
    expect(safe).toContain(`${'t'.repeat(53)}${ROCKET}`);
  });
});
