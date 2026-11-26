import { describe, expect, it } from 'vitest';
import { buildChimeraReviewTaskDescription } from '../src/chimera/chimera-review-task.js';

const ROCKET = '\u{1F680}';
const config = {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  maxFiles: 15,
  autoFix: 'off',
  cascadeOn: 'high',
  maxCascadeDepth: 2,
  fallbackModels: [],
  fallbackProfile: undefined,
};

function task(description: string): string {
  return buildChimeraReviewTaskDescription({
    cwd: '/repo',
    cascadeDepth: 1,
    deletedFiles: [],
    deletedFileReferences: [],
    signatureCallers: [],
    sessionIntent: [],
    config,
    files: [],
    kanbanCard: { title: 'card', description },
  } as never);
}

/**
 * F2635: the card description is embedded with a plain `.slice(0, 500)` while
 * this module already exports `truncateAtCodePointBoundary`. The builder's
 * output is the review agent's prompt, so a split surrogate pair reaches the
 * provider wire.
 */
describe('chimera review task keeps valid UTF-16 in the card block (F2635)', () => {
  it('drops the orphaned half instead of keeping it', () => {
    const out = task(`${'d'.repeat(499)}${ROCKET}tail`);

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('d'.repeat(499));
  });

  it('keeps an emoji that ends exactly at the cap', () => {
    const out = task(`${'d'.repeat(498)}${ROCKET}tail`);

    expect(out).toContain(`${'d'.repeat(498)}${ROCKET}`);
  });

  it('keeps short descriptions whole (control)', () => {
    expect(task('plain card text')).toContain('plain card text');
  });
});
