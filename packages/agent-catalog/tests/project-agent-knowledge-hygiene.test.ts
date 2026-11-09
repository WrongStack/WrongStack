/**
 * Project-specific learning has to stay true to the project and affordable to
 * inject. Three ways it was failing on this repository's own data:
 *
 *  - directives kept citing files that had since been deleted or moved, and
 *    nothing ever re-checked them;
 *  - the role document had no size bound and grew to 24 KB, all of it injected
 *    into every spawn of the role;
 *  - a plain word in code font became an attribution anchor, so a directive was
 *    "applied" whenever a report used that word.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProjectContextualizedPrompt,
  CONSOLIDATED_MAX_BYTES,
  captureLearnedFromAgentOutputDetailed,
  createStalePathChecker,
  directiveWasApplied,
  LEARNED_HARD_LIMIT,
  listProjectSkillAugmentations,
  loadProjectAgentConsolidated,
  loadProjectSkillAugmentation,
  readRawLearnedEntries,
  refreshStaleProjectAgentLearning,
  resetCaptureWindows,
  type StructuredLearnedEntry,
  saveProjectAgentConsolidated,
  saveProjectSkillAugmentation,
  scrubStaleLines,
  unwrapWholeDocumentFence,
  validateProjectAgentConfig,
} from '../src/index.js';
import { boundConsolidatedDocument } from '../src/project-agent-consolidation.js';

let projectRoot: string;

function touch(relative: string): void {
  const file = path.join(projectRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-knowledge-hygiene-'));
  resetCaptureWindows();
  touch('packages/core/package.json');
  touch('packages/core/src/index.ts');
  touch('packages/core/src/live.ts');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('stale path detection', () => {
  it('flags a cited repo path that no longer exists', () => {
    const checker = createStalePathChecker(projectRoot);
    expect(checker.stalePaths('Read `packages/core/src/gone.ts` first.')).toEqual([
      'packages/core/src/gone.ts',
    ]);
    expect(checker.stalePaths('Read `packages/core/src/live.ts:42` first.')).toEqual([]);
  });

  it('never judges globs, package specifiers, relative paths or unknown roots', () => {
    const checker = createStalePathChecker(projectRoot);
    expect(
      checker.stalePaths(
        'See `packages/core/src/**/*.ts`, `@wrongstack/core/gone`, `./local/gone.ts` and `vendor/lib/gone.ts`.',
      ),
    ).toEqual([]);
  });

  it('resolves package-relative citations against workspace packages', () => {
    touch('src/.keep');
    const checker = createStalePathChecker(projectRoot);
    // `src/index.ts` is not at the root, but it is `packages/core`'s entry.
    expect(checker.stalePaths('The barrel is `src/index.ts`.')).toEqual([]);
  });

  it('keeps a line that says the path is gone on purpose', () => {
    const checker = createStalePathChecker(projectRoot);
    expect(
      checker.stalePaths('`packages/core/src/old-mailbox.ts` was removed; use the IPC mailbox.'),
    ).toEqual([]);
  });

  it('scrubs a stale bullet with its continuation lines and keeps headings', () => {
    const checker = createStalePathChecker(projectRoot);
    const doc = [
      '## Pitfalls',
      '',
      '- Guard `packages/core/src/gone.ts` against double init.',
      '  - continuation of the stale bullet',
      '- Always export new symbols from `packages/core/src/index.ts`.',
    ].join('\n');
    const { text, removed } = scrubStaleLines(doc, checker);
    expect(removed).toHaveLength(1);
    expect(text).toContain('## Pitfalls');
    expect(text).not.toContain('gone.ts');
    expect(text).not.toContain('continuation');
    expect(text).toContain('packages/core/src/index.ts');
  });
});

describe('refreshStaleProjectAgentLearning', () => {
  it('drops stale knowledge from buffer, role document and addenda, and archives it', () => {
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways initialise the cache in `packages/core/src/gone.ts` before the first read.',
      'reviewer',
      projectRoot,
      true,
    );
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways export new public symbols from `packages/core/src/index.ts` so consumers never deep-import.',
      'reviewer',
      projectRoot,
      true,
    );
    saveProjectAgentConsolidated(
      'reviewer',
      '## Rules\n\n- Keep `packages/core/src/live.ts` pure and free of I/O.\n- Never edit `packages/core/src/gone.ts` by hand.\n',
      projectRoot,
    );
    saveProjectSkillAugmentation(
      'reviewer',
      'testing',
      '# Project practice\n\n- Mock `packages/core/src/gone.ts` in every suite that boots the host.\n',
      projectRoot,
    );

    const result = refreshStaleProjectAgentLearning('reviewer', projectRoot);

    expect(result.bufferEntries).toBe(1);
    expect(result.documentLines).toBe(2);
    expect(result.clearedSkills).toEqual(['testing']);
    const remaining = readRawLearnedEntries('reviewer', projectRoot).map((entry) => entry.what);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain('index.ts');
    expect(loadProjectAgentConsolidated('reviewer', projectRoot)).not.toContain('gone.ts');
    expect(loadProjectAgentConsolidated('reviewer', projectRoot)).toContain('live.ts');
    expect(listProjectSkillAugmentations('reviewer', projectRoot)).toEqual([]);
    const archive = path.join(projectRoot, '.wrongstack', 'agents', 'reviewer', 'archive');
    const staleFile = readdirSync(archive).find((name) => name.startsWith('stale-'));
    expect(staleFile).toBeDefined();
    expect(readFileSync(path.join(archive, staleFile as string), 'utf8')).toContain('gone.ts');
  });

  it('writes nothing when nothing is stale', () => {
    saveProjectSkillAugmentation(
      'reviewer',
      'testing',
      '# Project practice\n\n- Mock `packages/core/src/live.ts` in every suite that boots the host.\n',
      projectRoot,
    );
    const before = loadProjectSkillAugmentation('reviewer', 'testing', projectRoot);

    const result = refreshStaleProjectAgentLearning('reviewer', projectRoot);

    expect(result).toMatchObject({ bufferEntries: 0, documentLines: 0, clearedSkills: [] });
    expect(loadProjectSkillAugmentation('reviewer', 'testing', projectRoot)).toBe(before);
    expect(existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'reviewer', 'archive'))).toBe(
      false,
    );
  });

  it('clears and archives consolidated.md when every directive in it cites a stale path (F659)', () => {
    saveProjectAgentConsolidated(
      'reviewer',
      '## Rules\n\n- Never edit `packages/core/src/gone.ts` by hand.\n',
      projectRoot,
    );

    const result = refreshStaleProjectAgentLearning('reviewer', projectRoot);

    expect(result.documentLines).toBe(1);
    expect(loadProjectAgentConsolidated('reviewer', projectRoot)).toBe('');
    expect(buildProjectContextualizedPrompt('BASE', 'reviewer', projectRoot)).not.toContain(
      'gone.ts',
    );
  });
});

describe('role document budget', () => {
  const oversized = Array.from(
    { length: 400 },
    (_, i) => `- Rule ${i}: keep \`packages/core/src/live.ts\` free of side effects in path ${i}.`,
  ).join('\n');

  it('bounds the document on save, on whole lines, and says so', () => {
    saveProjectAgentConsolidated('reviewer', oversized, projectRoot);
    const saved = loadProjectAgentConsolidated('reviewer', projectRoot);
    expect(Buffer.byteLength(saved, 'utf8')).toBeLessThanOrEqual(CONSOLIDATED_MAX_BYTES);
    expect(saved).toContain('_(truncated at');
    expect(
      saved
        .split('\n')
        .filter((line) => line.startsWith('- Rule'))
        .at(-1),
    ).toMatch(/in path \d+\.$/);
  });

  it('bounds an oversized document written before the cap when injecting it', () => {
    saveProjectAgentConsolidated(
      'reviewer',
      '- seed rule that is long enough to count',
      projectRoot,
    );
    // Simulate a legacy document on disk, written without the bound.
    writeFileSync(
      path.join(projectRoot, '.wrongstack', 'agents', 'reviewer', 'consolidated.md'),
      oversized,
    );
    const prompt = buildProjectContextualizedPrompt('Base prompt.', 'reviewer', projectRoot);
    expect(prompt).toContain('_(truncated at');
    expect(prompt).not.toContain('Rule 399');
  });
});

describe('attribution anchors', () => {
  const entry = (
    how: string,
    what = 'Prefer the resolver over ad-hoc lookups here.',
  ): StructuredLearnedEntry => ({
    key: what,
    category: 'convention',
    what,
    why: '',
    how,
    capturedAt: '2026-09-01T00:00:00.000Z',
  });

  it('does not treat a plain word in code font as evidence', () => {
    expect(directiveWasApplied(entry('`resolve`'), 'We resolve the config at startup.')).toBe(
      false,
    );
  });

  it('still treats code-shaped anchors as evidence', () => {
    expect(
      directiveWasApplied(entry('`resolveProviderCfg`'), 'Traced resolveProviderCfg callers.'),
    ).toBe(true);
    expect(directiveWasApplied(entry('`server-node`'), 'Runs in the server-node project.')).toBe(
      true,
    );
  });
});

describe('raw buffer ceiling', () => {
  /** A directive whose tokens share nothing with any other index. */
  const word = (n: number): string =>
    [...String(n).padStart(4, '0')].map((d) => 'bcdfghjklm'[Number(d)]).join('') + 'ox';
  const directive = (i: number): string =>
    `Always configure ${Array.from({ length: 12 }, (_, j) => word(i * 12 + j)).join(' ')} before the host starts.`;

  it('evicts past LEARNED_HARD_LIMIT into the archive instead of growing forever', () => {
    for (let i = 0; i < 120; i++) {
      captureLearnedFromAgentOutputDetailed(
        `## LEARNED\n${directive(i)}`,
        'executor',
        projectRoot,
        true,
      );
    }
    const learned = readFileSync(
      path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'learned.md'),
      'utf8',
    );
    expect(Buffer.byteLength(learned, 'utf8')).toBeLessThanOrEqual(LEARNED_HARD_LIMIT);
    const archive = path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'archive');
    expect(readdirSync(archive).some((name) => name.startsWith('evicted-'))).toBe(true);
  });
});

describe('F45 regressions', () => {
  it('strips #L<line> fragments and normalizes backslashes in stale path detection', () => {
    const checker = createStalePathChecker(projectRoot);
    expect(
      checker.stalePaths(
        'Check `packages/core/src/live.ts#L10-L20` and `packages\\core\\src\\gone.ts`.',
      ),
    ).toEqual(['packages/core/src/gone.ts']);
  });

  it('preserves multi-block markdown fences and non-markdown code blocks in unwrapWholeDocumentFence', () => {
    const multiBlock =
      '```markdown\n# Example A\n```\n\nMiddle explanation.\n\n```ts\nconst x = 1;\n```';
    expect(unwrapWholeDocumentFence(multiBlock)).toBe(multiBlock);
    const tsBlock = '```ts\nexport const x = 1;\n```';
    expect(unwrapWholeDocumentFence(tsBlock)).toBe(tsBlock);
    expect(unwrapWholeDocumentFence('```markdown\n# Heading\n```')).toBe('# Heading');
  });

  it('slices an oversized single-line consolidated document at a UTF-8 boundary instead of dropping content', () => {
    const singleLongLine = `# Rules: ${'😀'.repeat(CONSOLIDATED_MAX_BYTES)}`;
    const bounded = boundConsolidatedDocument(singleLongLine);
    expect(bounded.startsWith('# Rules: 😀')).toBe(true);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(CONSOLIDATED_MAX_BYTES);
    expect(bounded).not.toContain('\uFFFD');
  });

  it('rejects Windows drive-relative paths in validateProjectAgentConfig', () => {
    expect(() => validateProjectAgentConfig({ cwd: 'C:subpath' })).toThrow(/must stay inside/);
  });

  it('strips line-range suffixes (:10-20) and surrounding brackets/parentheses in stale path detection (F114)', () => {
    const checker = createStalePathChecker(projectRoot);
    expect(
      checker.stalePaths(
        'Check `packages/core/src/live.ts:10-20`, [packages/core/src/live.ts#L10-L20], and `packages/core/src/gone.ts:10-20`.',
      ),
    ).toEqual(['packages/core/src/gone.ts']);
  });
});
