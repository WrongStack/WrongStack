import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureLearnedFromAgentOutputDetailed,
  directiveSimilarity,
  normalizeForComparison,
  parseStructuredLearnedEntries,
  renderSkillAugmentation,
  resetCaptureWindows,
  scrubRetiredLines,
  tokenOverlap,
  updateProjectAgentLearned,
} from '../src/index.js';

const FIRST = 'Always run focused tests before the full suite.';
const OPPOSITE = 'Always run the full suite before focused tests.';
const UNRELATED =
  'Always validate JWT tokens against an explicit allowlist before trusting claims.';
const REWORDED =
  'Always run `pnpm vitest run` from the repository root, since a package-local run resolves a wrong config file.';
const ORIGINAL =
  'Always run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-learning-order-'));
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function capture(text: string) {
  return captureLearnedFromAgentOutputDetailed(
    `## LEARNED\n${text}`,
    'verifier',
    projectRoot,
    true,
  );
}

describe('order-sensitive directive similarity', () => {
  it('preserves lexical overlap for conflict detection without treating inversions as identical', () => {
    const first = normalizeForComparison(FIRST);
    const opposite = normalizeForComparison(OPPOSITE);
    expect(first).not.toBe(opposite);
    expect(tokenOverlap(first, opposite)).toBe(1);
    expect(directiveSimilarity(first, opposite)).toBeLessThan(0.55);
  });

  it('keeps exact duplicates and genuine rewords above the dedup threshold', () => {
    expect(directiveSimilarity(FIRST, FIRST)).toBe(1);
    expect(
      directiveSimilarity(normalizeForComparison(ORIGINAL), normalizeForComparison(REWORDED)),
    ).toBeGreaterThanOrEqual(0.55);
    expect(directiveSimilarity('', '')).toBe(0);
    expect(directiveSimilarity('alpha', 'alpha')).toBe(1);
  });
});

describe('directive deduplication controls', () => {
  it('still rejects an exact duplicate', () => {
    expect(capture(FIRST).status).toBe('captured');
    expect(capture(FIRST).status).toBe('quality_rejected');
    expect(
      parseStructuredLearnedEntries('verifier', projectRoot).map((entry) => entry.what),
    ).toEqual([FIRST]);
  });

  it('still captures an unrelated directive', () => {
    expect(capture(FIRST).status).toBe('captured');
    expect(capture(UNRELATED).status).toBe('captured');
    expect(parseStructuredLearnedEntries('verifier', projectRoot)).toHaveLength(2);
  });
});

describe('order-sensitive directive identity', () => {
  it('capture retains two directives with the same token set but opposite ordering', () => {
    expect(capture(FIRST).status).toBe('captured');
    expect(capture(OPPOSITE).status).toBe('captured');
    expect(
      parseStructuredLearnedEntries('verifier', projectRoot).map((entry) => entry.what),
    ).toEqual([FIRST, OPPOSITE]);
  });

  it('taught append retains both order-sensitive directives', () => {
    updateProjectAgentLearned('verifier', FIRST, projectRoot);
    updateProjectAgentLearned('verifier', OPPOSITE, projectRoot);
    expect(
      parseStructuredLearnedEntries('verifier', projectRoot).map((entry) => entry.what),
    ).toEqual([FIRST, OPPOSITE]);
  });

  it('skill augmentation keeps an inverted directive instead of dropping it as a duplicate', () => {
    const at = '2026-11-24T00:00:00.000Z';
    const existing = renderSkillAugmentation('verifier', 'testing', [FIRST], at);
    const merged = renderSkillAugmentation('verifier', 'testing', [FIRST, OPPOSITE], at, existing);
    expect(merged).toContain(FIRST);
    expect(merged).toContain(OPPOSITE);
  });

  it('retired-directive scrubbing removes the retired rule but keeps its inversion', () => {
    const document = `# Rules\n\n- ${FIRST}\n- ${OPPOSITE}\n`;
    const scrubbed = scrubRetiredLines(document, [FIRST]);
    expect(scrubbed).not.toContain(FIRST);
    expect(scrubbed).toContain(OPPOSITE);
  });
});
