import { describe, expect, it } from 'vitest';
import { isChimeraAllClearReview } from '../src/chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  CHIMERA_REVIEW_READ_ONLY_TOOLS,
} from '../src/execution.js';

describe('Chimera reviewer tool policy', () => {
  it('exposes only read-only inspection tools', () => {
    const config = applyChimeraReviewerReadOnlyPolicy({
      name: 'chimera-review',
      tools: ['edit', 'write', 'patch', 'exec'],
      allowedCapabilities: ['fs.write', 'shell.exec'],
    });

    expect(config.tools).toEqual([...CHIMERA_REVIEW_READ_ONLY_TOOLS]);
    expect(config.allowedCapabilities).toEqual(['fs.read']);
    expect(config.worktree).toBe('off');
    expect(config.tools).not.toEqual(
      expect.arrayContaining([
        'edit',
        'write',
        'patch',
        'update',
        'replace',
        'format',
        'bash',
        'exec',
        'git',
      ]),
    );
  });
});

describe('Chimera all-clear classification', () => {
  it('recognizes canonical clean review reports', () => {
    expect(
      isChimeraAllClearReview(
        '## 🦂 Chimera Review — all clear ✅\nNo issues found in 2 changed files.',
      ),
    ).toBe(true);
  });

  it('recognizes legacy clean review wording', () => {
    expect(isChimeraAllClearReview('🦂 Chimera review: all clear — no issues found.')).toBe(true);
  });

  it('does not classify reports with findings as all-clear', () => {
    expect(
      isChimeraAllClearReview('## 🦂 Chimera Review\n\n### High (1)\n1. [BUG] src/a.ts:1 — broken'),
    ).toBe(false);
  });

  it('does not classify mixed finding reports as all-clear just because they say no issues found', () => {
    expect(
      isChimeraAllClearReview(
        '## 🦂 Chimera Review\n\n### High (1)\n1. [BUG] src/a.ts:1 — broken\n\nNo issues found in other files.',
      ),
    ).toBe(false);
  });
});
