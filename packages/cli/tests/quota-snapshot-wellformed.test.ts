import { describe, expect, it } from 'vitest';
import { renderQuotaSnapshot } from '../src/slash-commands/openai-quota.js';

const ROCKET = '\u{1F680}';

const snapshot = (note: string) =>
  ({
    providerId: 'openai',
    windows: [],
    capturedAt: Date.now(),
    note,
  }) as never;

/**
 * F2655: `renderQuotaSnapshot` caps the provider note at 200 UTF-16 units with a
 * plain `.slice`. Provider notes are external text rendered in the TUI.
 */
describe('quota snapshot note keeps valid UTF-16 (F2655)', () => {
  it('drops the orphaned half in the note', () => {
    const out = renderQuotaSnapshot(snapshot(`${'n'.repeat(199)}${ROCKET}tail`)).join('\n');

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('n'.repeat(199));
  });

  it('keeps a short note unchanged (control)', () => {
    const out = renderQuotaSnapshot(snapshot('plain note')).join('\n');

    expect(out).toContain('plain note');
  });
});
