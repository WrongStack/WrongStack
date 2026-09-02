import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProjectContextualizedPrompt,
  captureLearnedFromAgentOutputDetailed,
  enforceLearnedBudget,
  getProjectAgentLearnStats,
  LEARNED_SOFT_LIMIT,
  listProjectSkillAugmentations,
  loadConsolidationMetadata,
  loadProjectAgentLearned,
  loadProjectSkillAugmentation,
  loadSkillAffinity,
  optimizeProjectAgentLearning,
  parseStructuredLearnedEntriesFromContent,
  rankRoleSkills,
  recordSkillOutcome,
  renderLearnedInstructions,
  resetCaptureWindows,
  routeDirectiveToSkill,
  saveProjectAgentConsolidated,
  saveProjectSkillAugmentation,
  setSkillPinned,
  splitLearnedEntries,
  updateProjectAgentLearned,
} from '../../src/coordination/agents/index.js';
import type { Provider, Request, Response } from '../../src/types/index.js';

let projectRoot: string;

function learnedPath(role: string): string {
  return path.join(projectRoot, '.wrongstack', 'agents', role, 'learned.md');
}

/** Minimal provider stub that echoes a fixed document. */
function stubLlm(reply: string, onCall?: (req: Request) => void) {
  const provider = {
    capabilities: {},
    async complete(req: Request): Promise<Response> {
      onCall?.(req);
      return { content: [{ type: 'text', text: reply }] } as unknown as Response;
    },
  } as unknown as Provider;
  return { provider, model: 'stub-model' };
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-skill-layer-'));
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('learned buffer round-trip', () => {
  it('is a fixed point: rendering a parsed document reproduces it byte for byte', () => {
    const at = '2026-08-09T10:00:00.000Z';
    const first = renderLearnedInstructions(
      'executor',
      [
        {
          key: 'k',
          category: 'convention',
          what: 'Always run `pnpm typecheck` before declaring work complete in `packages/core/src/a.ts`.',
          why: 'Because it catches regressions.',
          how: '`pnpm typecheck`\n`packages/core/src/a.ts`',
          capturedAt: at,
        },
      ],
      at,
    );
    const reparsed = parseStructuredLearnedEntriesFromContent(first, splitLearnedEntries(first));
    expect(reparsed).toHaveLength(1);
    const second = renderLearnedInstructions('executor', reparsed, at);
    expect(second).toBe(first);
    // The nesting defect showed up on the *second* render, so assert it directly.
    expect(second).not.toMatch(/How:\*\s+-\s+\*How/);
  });

  it('repairs a buffer that already carries nested How labels', () => {
    const at = '2026-08-09T10:00:00.000Z';
    const corrupted = [
      '# Learned instructions for `executor`',
      '',
      '## What to do',
      '',
      `<!-- learned-stamp: category=convention; capturedAt=${at} -->`,
      '- **Always run the strict typecheck project before finishing a change.**',
      '  - *Why:* Established convention.',
      '  - *How:* `pnpm typecheck`',
      '  - *How:*   - *How:* `packages/core/tsconfig.json`',
      '',
      '---',
      `*Last capture: ${at} · 1 entries*`,
      '',
    ].join('\n');
    const entries = parseStructuredLearnedEntriesFromContent(
      corrupted,
      splitLearnedEntries(corrupted),
    );
    expect(entries[0]?.how.split('\n')).toEqual([
      '`pnpm typecheck`',
      '`packages/core/tsconfig.json`',
    ]);
    expect(renderLearnedInstructions('executor', entries, at)).not.toMatch(/How:\*\s+-\s+\*How/);
  });

  it('keeps a .json anchor intact instead of truncating it to .js', () => {
    resetCaptureWindows();
    const result = captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways run the strict test typecheck at `packages/kanban/tsconfig.test.json` before finishing.',
      'executor',
      projectRoot,
      true,
    );
    expect(result.status).toBe('captured');
    const buffer = loadProjectAgentLearned('executor', projectRoot);
    expect(buffer).toContain('packages/kanban/tsconfig.test.json');
    expect(buffer).not.toMatch(/tsconfig\.test\.js`/);
  });
});

describe('capture is never permanently blocked by buffer size', () => {
  it('trims the cheapest entries instead of refusing to learn', () => {
    const filler = Array.from({ length: 40 }, (_, i) => ({
      key: `k${i}`,
      category: 'fact' as const,
      what: `The project fact number ${i} is a long sentence used to fill the learning buffer well past its budget.`,
      why: 'Current state of the project.',
      how: '',
      capturedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    mkdirSync(path.dirname(learnedPath('executor')), { recursive: true });
    writeFileSync(
      learnedPath('executor'),
      renderLearnedInstructions('executor', filler, '2026-01-01T00:00:00.000Z'),
      'utf8',
    );
    const before = Buffer.byteLength(loadProjectAgentLearned('executor', projectRoot), 'utf8');
    expect(before).toBeGreaterThan(LEARNED_SOFT_LIMIT);

    const result = captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways verify the release checklist before publishing a package from this repository.',
      'executor',
      projectRoot,
      false,
    );
    expect(result.status).toBe('captured');
    expect(result.evicted ?? 0).toBeGreaterThan(0);
    const after = loadProjectAgentLearned('executor', projectRoot);
    expect(Buffer.byteLength(after, 'utf8')).toBeLessThanOrEqual(LEARNED_SOFT_LIMIT);
    expect(after).toContain('verify the release checklist');
  });

  it('evicts plain facts before warnings', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const entry = (category: 'fact' | 'warning', i: number) => ({
      key: `${category}${i}`,
      category,
      what: `${category} number ${i}: ${'padding '.repeat(30)}`,
      why: 'why',
      how: '',
      capturedAt: at,
    });
    const mixed = [entry('fact', 1), entry('warning', 1), entry('fact', 2), entry('warning', 2)];
    const { kept, dropped } = enforceLearnedBudget(mixed, at, 1_400, 'executor');
    expect(dropped.length).toBeGreaterThan(0);
    // Facts go first; a warning only goes once every fact is already gone.
    expect(dropped[0]?.category).toBe('fact');
    expect(kept.some((e) => e.category === 'warning')).toBe(true);
  });
});

describe('skill routing and the project skill layer', () => {
  it('honours an explicit [skill: x] tag', () => {
    expect(
      routeDirectiveToSkill('Some rule [skill: testing] applies', ['testing', 'git-flow']),
    ).toBe('testing');
  });

  it('routes by vocabulary when untagged, and declines when nothing matches', () => {
    expect(
      routeDirectiveToSkill('Run vitest with a focused test file before the full suite.', [
        'testing',
        'git-flow',
      ]),
    ).toBe('testing');
    expect(routeDirectiveToSkill('Be nice to reviewers.', ['testing', 'git-flow'])).toBeUndefined();
  });

  it('stamps the routed skill onto the captured directive and counts it', () => {
    const result = captureLearnedFromAgentOutputDetailed(
      '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      'verifier',
      projectRoot,
      true,
    );
    expect(result.status).toBe('captured');
    expect(result.skills).toEqual(['testing']);
    expect(loadProjectAgentLearned('verifier', projectRoot)).toContain('skill=testing');
    expect(loadSkillAffinity('verifier', projectRoot).entries['testing']?.learned).toBe(1);
    expect(getProjectAgentLearnStats('verifier', projectRoot).skilledEntryCount).toBe(1);
  });
});

describe('optimization writes skill addenda and unblocks the buffer', () => {
  it('distils routed directives into <skill>.md, prunes the raw buffer, and archives it', async () => {
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      'verifier',
      projectRoot,
      true,
    );
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways state the verification you actually performed rather than implying it.',
      'verifier',
      projectRoot,
      true,
    );

    const seenSystems: string[] = [];
    const result = await optimizeProjectAgentLearning('verifier', projectRoot, {
      llm: stubLlm('# Consolidated\n\n- Verify from the repo root.', (req) => {
        seenSystems.push(req.system?.[0]?.text ?? '');
      }),
      trigger: 'manual',
    });

    expect(result.status).toBe('optimized');
    expect(result.skills).toEqual(['testing']);
    // One call for the skill addendum, one for the role document.
    expect(seenSystems).toHaveLength(2);

    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual(['testing']);
    expect(loadProjectSkillAugmentation('verifier', 'testing', projectRoot)).toContain(
      'Consolidated',
    );

    // The raw buffer is reset (so the size gate can never wedge) and archived.
    const stats = getProjectAgentLearnStats('verifier', projectRoot);
    expect(stats.entryCount).toBe(0);
    const meta = loadConsolidationMetadata('verifier', projectRoot);
    expect(meta?.pruned).toBe(true);
    expect(meta?.sourceEntryCount).toBe(0);
    expect(readFileSync(meta?.archivePath ?? '', 'utf8')).toContain('vitest run');
  });

  it('still develops the skill layer when no model is available', async () => {
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED [skill: git-flow]\nAlways rebase onto the latest main before opening a pull request in this repository.',
      'executor',
      projectRoot,
      true,
    );
    const result = await optimizeProjectAgentLearning('executor', projectRoot);
    expect(result.status).toBe('no-llm');
    expect(result.instruction).toContain('rebase onto the latest main');
    // The addendum is written deterministically rather than lost.
    expect(loadProjectSkillAugmentation('executor', 'git-flow', projectRoot)).toContain(
      'rebase onto the latest main',
    );
  });

  it('reports no-entries without consulting a model', async () => {
    let called = false;
    const result = await optimizeProjectAgentLearning('executor', projectRoot, {
      llm: stubLlm('unused', () => {
        called = true;
      }),
    });
    expect(result.status).toBe('no-entries');
    expect(called).toBe(false);
  });
});

describe('prompt assembly', () => {
  it('injects only the post-consolidation delta, chosen by timestamp not list order', () => {
    saveProjectAgentConsolidated(
      'reviewer',
      '# Consolidated\n\n- Review the diff first.',
      projectRoot,
    );
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways check that new state counters are reset in both setup and teardown paths.',
      'reviewer',
      projectRoot,
      true,
    );
    const prompt = buildProjectContextualizedPrompt('BASE', 'reviewer', projectRoot);
    expect(prompt).toContain('Review the diff first');
    expect(prompt).toContain('pending next optimization');
    expect(prompt).toContain('reset in both setup and teardown');
  });

  it('does not label a raw buffer as consolidated when metadata is missing', () => {
    mkdirSync(path.dirname(learnedPath('critic')), { recursive: true });
    writeFileSync(learnedPath('critic'), '# raw\n\nSome raw text.', 'utf8');
    writeFileSync(
      path.join(projectRoot, '.wrongstack', 'agents', 'critic', 'consolidated.md'),
      '# Hand written',
      'utf8',
    );
    const prompt = buildProjectContextualizedPrompt('BASE', 'critic', projectRoot);
    expect(prompt).toContain('Learned instructions for this project');
    expect(prompt).not.toContain('Consolidated knowledge for this project');
  });

  it('advertises a skill only once the project has written its addendum', () => {
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root for a single test file.',
      'verifier',
      projectRoot,
      true,
    );
    // A routed capture alone is not yet a developed skill — the addendum is.
    expect(buildProjectContextualizedPrompt('BASE', 'verifier', projectRoot)).not.toContain(
      'Project-developed skills',
    );
    saveProjectSkillAugmentation('verifier', 'testing', '- Run from the repo root.', projectRoot);
    const prompt = buildProjectContextualizedPrompt('BASE', 'verifier', projectRoot);
    expect(prompt).toContain('Project-developed skills');
    expect(prompt).toContain('`testing`');
  });
});

describe('teach flow', () => {
  it('survives a subsequent capture instead of being silently deleted', () => {
    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways prefer the workspace root script over a package-local one for cross-package checks.',
      'executor',
      projectRoot,
      true,
    );
    updateProjectAgentLearned(
      'executor',
      'Always use pnpm for this project; npm install corrupts the workspace links.',
      projectRoot,
      'append',
    );
    expect(loadProjectAgentLearned('executor', projectRoot)).toContain('Always use pnpm');

    captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nAlways attach the failing command output when reporting a broken build step.',
      'executor',
      projectRoot,
      true,
    );
    const buffer = loadProjectAgentLearned('executor', projectRoot);
    expect(buffer).toContain('Always use pnpm');
    expect(buffer).toContain('failing command output');
  });
});

describe('skill affinity ranking', () => {
  it('keeps the curated order when the project has no history', () => {
    const curated = ['a-skill', 'b-skill', 'c-skill', 'd-skill'];
    expect(rankRoleSkills('executor', curated, projectRoot, 3)).toEqual([
      'a-skill',
      'b-skill',
      'c-skill',
    ]);
  });

  it('promotes a skill the project actually developed over an unused sibling', () => {
    const curated = ['a-skill', 'b-skill', 'c-skill', 'd-skill'];
    recordSkillOutcome('executor', ['d-skill'], true, projectRoot);
    recordSkillOutcome('executor', ['d-skill'], true, projectRoot);
    expect(rankRoleSkills('executor', curated, projectRoot, 3)).toContain('d-skill');
  });

  it('always keeps a pinned skill', () => {
    const curated = ['a-skill', 'b-skill', 'c-skill', 'd-skill'];
    setSkillPinned('executor', 'd-skill', true, projectRoot);
    expect(rankRoleSkills('executor', curated, projectRoot, 1)).toEqual(['d-skill']);
  });
});
