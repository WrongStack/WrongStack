/**
 * Outcome-driven learning: the reward the environment produces has to reach the
 * directives themselves, not just the per-skill counters beside them.
 *
 * Every case here is a decision the loop used to make on age or arrival order
 * alone — which directive to evict, which one a near-duplicate replaces, which
 * skill to load, whether a pass may re-run.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProjectContextualizedPrompt,
  buildSkillDistillInstruction,
  captureLearnedFromAgentOutputDetailed,
  DEFAULT_AUTO_OPTIMIZE_POLICY,
  directiveTrials,
  directiveUtility,
  directiveWasApplied,
  enforceLearnedBudget,
  evaluateAutoOptimize,
  getProjectAgentLearnStats,
  listProjectSkillAugmentations,
  loadProjectAgentConsolidated,
  loadProjectAgentLearned,
  loadProjectAgentLearningPolicy,
  loadProjectSkillAugmentation,
  optimizeProjectAgentLearning,
  parseStructuredLearnedEntriesFromContent,
  quarantinePath,
  readRawLearnedEntries,
  recordDirectiveOutcomes,
  renderLearnedInstructions,
  renderSkillAugmentation,
  resetCaptureWindows,
  retiredDirectivesToWarnAbout,
  SKILL_AUGMENTATION_MAX_BYTES,
  type SkillAffinityEntry,
  type StructuredLearnedEntry,
  saveProjectAgentConsolidated,
  saveProjectSkillAugmentation,
  scoreSkillAffinity,
  splitLearnedEntries,
  updateProjectAgentLearned,
} from '../../src/coordination/agents/index.js';
import type { Provider, Request, Response } from '../../src/types/index.js';

let projectRoot: string;

const VITEST_DIRECTIVE =
  'Always run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.';

function capture(role: string, text: string): void {
  const result = captureLearnedFromAgentOutputDetailed(
    `## LEARNED\n${text}`,
    role,
    projectRoot,
    true,
  );
  expect(result.status).toBe('captured');
}

function entryOf(role: string, needle: string): StructuredLearnedEntry {
  const found = readRawLearnedEntries(role, projectRoot).find((entry) =>
    entry.what.includes(needle),
  );
  if (!found) throw new Error(`no directive containing "${needle}"`);
  return found;
}

function affinity(patch: Partial<SkillAffinityEntry>): SkillAffinityEntry {
  return { loaded: 0, succeeded: 0, failed: 0, learned: 0, ...patch };
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-directive-outcome-'));
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('attribution', () => {
  it('credits a directive whose anchor appears in the report, and no others', () => {
    capture('verifier', VITEST_DIRECTIVE);
    capture(
      'verifier',
      'Always state the verification you actually performed rather than implying it.',
    );

    const outcome = recordDirectiveOutcomes(
      'verifier',
      'Ran `pnpm vitest run` at the repo root; three suites green.',
      true,
      projectRoot,
    );

    expect(outcome.attributed).toBe(1);
    expect(directiveTrials(entryOf('verifier', 'vitest run'))).toEqual({
      applied: 1,
      wins: 1,
      losses: 0,
    });
    expect(directiveTrials(entryOf('verifier', 'verification you actually'))).toEqual({
      applied: 0,
      wins: 0,
      losses: 0,
    });
  });

  it('records a loss without touching the win counter', () => {
    capture('verifier', VITEST_DIRECTIVE);
    recordDirectiveOutcomes('verifier', 'pnpm vitest run blew up on import.', false, projectRoot);
    expect(directiveTrials(entryOf('verifier', 'vitest run'))).toEqual({
      applied: 1,
      wins: 0,
      losses: 1,
    });
  });

  it('leaves the buffer untouched when nothing was exercised', () => {
    capture('verifier', VITEST_DIRECTIVE);
    const before = loadProjectAgentLearned('verifier', projectRoot);
    const outcome = recordDirectiveOutcomes(
      'verifier',
      'Wrote some documentation.',
      true,
      projectRoot,
    );
    expect(outcome.attributed).toBe(0);
    expect(loadProjectAgentLearned('verifier', projectRoot)).toBe(before);
  });

  it('needs more than a stray word to attribute an anchorless directive', () => {
    const anchorless: StructuredLearnedEntry = {
      key: 'k',
      category: 'convention',
      what: 'Always describe reproduction steps before proposing a remedy for a reported defect.',
      why: 'why',
      how: '',
      capturedAt: '2026-08-01T00:00:00.000Z',
    };
    expect(directiveWasApplied(anchorless, 'The remedy was straightforward.')).toBe(false);
    expect(
      directiveWasApplied(
        anchorless,
        'I documented the reproduction steps for the reported defect, then proposed a remedy and described the tradeoff.',
      ),
    ).toBe(true);
  });
});

describe('the record survives the buffer', () => {
  it('renders and re-parses the counters as a fixed point', () => {
    const at = '2026-08-09T10:00:00.000Z';
    const entry: StructuredLearnedEntry = {
      key: 'k',
      category: 'convention',
      what: VITEST_DIRECTIVE,
      why: 'Established convention.',
      how: '`pnpm vitest run`',
      capturedAt: at,
      applied: 6,
      wins: 5,
    };
    const first = renderLearnedInstructions('verifier', [entry], at);
    expect(first).toContain('applied=6; wins=5');
    const reparsed = parseStructuredLearnedEntriesFromContent(first, splitLearnedEntries(first));
    expect(directiveTrials(reparsed[0] as StructuredLearnedEntry)).toEqual({
      applied: 6,
      wins: 5,
      losses: 1,
    });
    expect(renderLearnedInstructions('verifier', reparsed, at)).toBe(first);
  });

  it('renders a record-less entry exactly as it did before the field existed', () => {
    const at = '2026-08-09T10:00:00.000Z';
    const rendered = renderLearnedInstructions(
      'verifier',
      [
        {
          key: 'k',
          category: 'convention',
          what: VITEST_DIRECTIVE,
          why: 'Established convention.',
          how: '`pnpm vitest run`',
          capturedAt: at,
        },
      ],
      at,
    );
    expect(rendered).toContain(`<!-- learned-stamp: category=convention; capturedAt=${at} -->`);
    expect(rendered).not.toContain('applied=');
  });

  // Automatic capture rejects a near-duplicate outright, so the *taught* path
  // (`updateProjectAgentLearned`, a human writing into the buffer) is the only
  // one that reaches the merge and can replace an existing directive.
  it('carries the record across a taught reword, but not across an inverted rule', () => {
    capture('verifier', VITEST_DIRECTIVE);
    recordDirectiveOutcomes('verifier', 'used `pnpm vitest run`', true, projectRoot);
    recordDirectiveOutcomes('verifier', 'used `pnpm vitest run` again', true, projectRoot);
    expect(directiveTrials(entryOf('verifier', 'vitest run')).applied).toBe(2);

    // Same claim, different words: the record follows it rather than restarting.
    updateProjectAgentLearned(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, since a package-local run resolves a wrong config file.',
      projectRoot,
      'append',
    );
    const reworded = entryOf('verifier', 'since a package-local run');
    expect(directiveTrials(reworded).applied).toBe(2);

    // Same words, opposite claim: a different category, so it earns its own record.
    updateProjectAgentLearned(
      'verifier',
      'Avoid running `pnpm vitest run` from the repository root; a package-local run resolves the config faster.',
      projectRoot,
      'append',
    );
    expect(directiveTrials(entryOf('verifier', 'Avoid running')).applied).toBe(0);
  });

  it('does not let a taught near-duplicate overwrite a directive that keeps working', () => {
    capture('verifier', VITEST_DIRECTIVE);
    for (let i = 0; i < 6; i++) {
      recordDirectiveOutcomes('verifier', `run ${i}: \`pnpm vitest run\``, true, projectRoot);
    }
    const proven = entryOf('verifier', 'vitest run');
    expect(directiveTrials(proven).applied).toBe(6);

    updateProjectAgentLearned(
      'verifier',
      'Always run `pnpm vitest run` from the repository root, since a package-local run resolves a wrong config file.',
      projectRoot,
      'append',
    );
    const after = readRawLearnedEntries('verifier', projectRoot).filter((entry) =>
      entry.what.includes('vitest run'),
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.what).toBe(proven.what);
    expect(directiveTrials(after[0] as StructuredLearnedEntry).applied).toBe(6);
  });

  it('rejects a near-duplicate at capture, leaving the proven original in place', () => {
    capture('verifier', VITEST_DIRECTIVE);
    recordDirectiveOutcomes('verifier', '`pnpm vitest run`', true, projectRoot);
    const again = captureLearnedFromAgentOutputDetailed(
      `## LEARNED\n${VITEST_DIRECTIVE}`,
      'verifier',
      projectRoot,
      true,
    );
    expect(again.status).toBe('quality_rejected');
    expect(directiveTrials(entryOf('verifier', 'vitest run')).applied).toBe(1);
  });
});

describe('retirement', () => {
  it('stops injecting a directive that keeps losing, and logs why', () => {
    capture('verifier', VITEST_DIRECTIVE);
    let quarantined: string[] = [];
    for (let i = 0; i < 8; i++) {
      quarantined = recordDirectiveOutcomes(
        'verifier',
        `attempt ${i} with \`pnpm vitest run\``,
        false,
        projectRoot,
      ).quarantined;
    }
    expect(quarantined).toHaveLength(1);
    expect(loadProjectAgentLearned('verifier', projectRoot)).not.toContain('vitest run');
    const retired = readFileSync(quarantinePath('verifier', projectRoot), 'utf8');
    expect(retired).toContain('vitest run');
    expect(retired).toContain('0 succeeded / 8 failed');
  });

  it('takes the retired rule out of the skill addendum it was distilled into', async () => {
    capture('verifier', `[skill: testing] ${VITEST_DIRECTIVE}`);
    capture(
      'verifier',
      '[skill: testing] Always add a focused spec alongside a fix under `packages/core/tests`.',
    );
    await optimizeProjectAgentLearning('verifier', projectRoot);
    const distilled = loadProjectSkillAugmentation('verifier', 'testing', projectRoot);
    expect(distilled).toContain('vitest run');
    expect(distilled).toContain('focused spec');

    for (let i = 0; i < 8; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run` failed again', false, projectRoot);
    }

    const after = loadProjectSkillAugmentation('verifier', 'testing', projectRoot);
    expect(after).not.toContain('vitest run');
    // The other rule this project learned for the same skill is untouched.
    expect(after).toContain('focused spec');
  });

  it('deletes an addendum whose every rule was retired', async () => {
    capture('verifier', `[skill: testing] ${VITEST_DIRECTIVE}`);
    await optimizeProjectAgentLearning('verifier', projectRoot);
    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual(['testing']);

    for (let i = 0; i < 8; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run` failed again', false, projectRoot);
    }
    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual([]);
  });

  it('takes the retired rule out of the consolidated role document too', () => {
    capture('verifier', VITEST_DIRECTIVE);
    saveProjectAgentConsolidated(
      'verifier',
      [
        '# Consolidated',
        '',
        `- ${VITEST_DIRECTIVE}`,
        '- Always attach the failing command output when reporting a broken build step.',
      ].join('\n'),
      projectRoot,
    );

    for (let i = 0; i < 8; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run` failed again', false, projectRoot);
    }

    const doc = loadProjectAgentConsolidated('verifier', projectRoot);
    expect(doc).not.toContain('vitest run');
    expect(doc).toContain('failing command output');
    expect(buildProjectContextualizedPrompt('BASE', 'verifier', projectRoot)).not.toContain(
      'vitest run',
    );
  });

  it('warns the distiller about retired rules, unless the role re-learned them', () => {
    capture('verifier', `[skill: testing] ${VITEST_DIRECTIVE}`);
    for (let i = 0; i < 8; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run` failed again', false, projectRoot);
    }
    expect(retiredDirectivesToWarnAbout('verifier', [], projectRoot)).toHaveLength(1);
    expect(
      buildSkillDistillInstruction(
        'verifier',
        'testing',
        ['something else entirely about fixtures'],
        '',
        retiredDirectivesToWarnAbout('verifier', [], projectRoot, 'testing'),
      ),
    ).toContain('do not reinstate');

    // Written again by the agent: it is back in the buffer and gets a retrial,
    // so the distiller must not be told to veto it.
    expect(retiredDirectivesToWarnAbout('verifier', [VITEST_DIRECTIVE], projectRoot)).toEqual([]);
  });

  it('keeps a directive that loses a few times but recovers', () => {
    capture('verifier', VITEST_DIRECTIVE);
    for (let i = 0; i < 3; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run`', false, projectRoot);
    }
    for (let i = 0; i < 6; i++) {
      recordDirectiveOutcomes('verifier', '`pnpm vitest run`', true, projectRoot);
    }
    expect(existsSync(quarantinePath('verifier', projectRoot))).toBe(false);
    expect(directiveTrials(entryOf('verifier', 'vitest run'))).toEqual({
      applied: 9,
      wins: 6,
      losses: 3,
    });
  });
});

describe('eviction weighs the record before the clock', () => {
  it('drops the losing directive and keeps the newer proven one', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const base = (what: string, extra: Partial<StructuredLearnedEntry>) =>
      ({
        key: what,
        category: 'fact' as const,
        what: `${what}: ${'padding '.repeat(30)}`,
        why: 'why',
        how: '',
        capturedAt: at,
        ...extra,
      }) satisfies StructuredLearnedEntry;

    const { kept, dropped } = enforceLearnedBudget(
      [
        base('proven', { applied: 6, wins: 6 }),
        base('losing', { applied: 6, wins: 0 }),
        base('unproven', {}),
      ],
      at,
      1_200,
      'executor',
    );
    expect(dropped[0]?.what).toContain('losing');
    expect(kept.map((entry) => entry.what.split(':')[0])).toContain('proven');
    expect(directiveUtility(base('losing', { applied: 6, wins: 0 }))).toBeLessThan(
      directiveUtility(base('unproven', {})),
    );
  });
});

describe('skill scoring', () => {
  it('ranks a losing skill below one that has never been tried', () => {
    const untried = scoreSkillAffinity(undefined);
    const losing = scoreSkillAffinity(
      affinity({ loaded: 10, failed: 10, lastUsedAt: new Date().toISOString() }),
    );
    expect(losing).toBeLessThan(untried);
  });

  it('scores every candidate identically when the project has no history', () => {
    expect(scoreSkillAffinity(undefined)).toBe(scoreSkillAffinity(affinity({})));
  });

  it('fades stale evidence toward neutral', () => {
    const old = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    expect(scoreSkillAffinity(affinity({ loaded: 8, succeeded: 8, lastUsedAt: old }))).toBeLessThan(
      scoreSkillAffinity(affinity({ loaded: 8, succeeded: 8, lastUsedAt: fresh })),
    );
  });

  it('treats a missing lastUsedAt as unknown rather than ancient', () => {
    expect(scoreSkillAffinity(affinity({ succeeded: 8 }))).toBeGreaterThan(
      scoreSkillAffinity(affinity({})),
    );
  });

  it('does not pay a skill for having been selected', () => {
    // Same outcome record, different exposure: more loads must not score higher.
    const at = new Date().toISOString();
    expect(
      scoreSkillAffinity(affinity({ loaded: 20, succeeded: 4, failed: 4, lastUsedAt: at })),
    ).toBeLessThan(
      scoreSkillAffinity(affinity({ loaded: 2, succeeded: 4, failed: 4, lastUsedAt: at })),
    );
  });
});

describe('optimization pass', () => {
  /** Throws on the first call (a skill distillation), answers the rest. */
  function flakyLlm(reply: string) {
    let calls = 0;
    const provider = {
      capabilities: {},
      async complete(_req: Request): Promise<Response> {
        calls++;
        if (calls === 1) throw new Error('provider timeout');
        return { content: [{ type: 'text', text: reply }] } as unknown as Response;
      },
    } as unknown as Provider;
    return { provider, model: 'stub-model' };
  }

  function stubLlm(reply: string) {
    const provider = {
      capabilities: {},
      async complete(): Promise<Response> {
        return { content: [{ type: 'text', text: reply }] } as unknown as Response;
      },
    } as unknown as Provider;
    return { provider, model: 'stub-model' };
  }

  it('keeps an earlier addendum when a per-skill call fails and the buffer is then pruned', async () => {
    capture('verifier', `[skill: testing] ${VITEST_DIRECTIVE}`);
    await optimizeProjectAgentLearning('verifier', projectRoot, {
      llm: stubLlm('# Project practice\n\n- Run the suite from the repository root.'),
    });
    expect(loadProjectSkillAugmentation('verifier', 'testing', projectRoot)).toContain(
      'from the repository root',
    );
    // The pass pruned the buffer, so the earlier directive exists only in the addendum.
    expect(getProjectAgentLearnStats('verifier', projectRoot).entryCount).toBe(0);

    capture(
      'verifier',
      '[skill: testing] Always add a regression test alongside a fix in `packages/core/tests`.',
    );
    await optimizeProjectAgentLearning('verifier', projectRoot, {
      llm: flakyLlm('# Consolidated\n\n- Something.'),
    });

    const addendum = loadProjectSkillAugmentation('verifier', 'testing', projectRoot);
    expect(addendum).toContain('from the repository root');
    expect(addendum).toContain('regression test');
  });

  it('keeps the newest directives when an addendum is over budget', () => {
    const old = Array.from({ length: 60 }, (_, i) => `- Old rule ${i}: ${'padding '.repeat(12)}`);
    saveProjectSkillAugmentation(
      'executor',
      'git-flow',
      ['# Project practice: `git-flow`', '', ...old].join('\n'),
      projectRoot,
    );
    const body = renderSkillAugmentation(
      'executor',
      'git-flow',
      ['Always rebase onto the latest main before opening a pull request.'],
      '2026-08-10T00:00:00.000Z',
      loadProjectSkillAugmentation('executor', 'git-flow', projectRoot),
    );
    saveProjectSkillAugmentation('executor', 'git-flow', body, projectRoot);

    const stored = loadProjectSkillAugmentation('executor', 'git-flow', projectRoot);
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(SKILL_AUGMENTATION_MAX_BYTES);
    expect(stored).toContain('# Project practice: `git-flow`');
    expect(stored).toContain('rebase onto the latest main');
    expect(stored).toContain('truncated at');
    // The head is what gets dropped; a mid-line cut would leave a broken anchor.
    expect(stored).not.toContain('Old rule 0:');
    expect(stored.split('\n').every((line) => !line.endsWith('paddin'))).toBe(true);
  });

  it('does not rewrite an addendum that has nothing new to add', async () => {
    capture(
      'executor',
      `[skill: git-flow] Always rebase onto the latest main before opening a pull request.`,
    );
    await optimizeProjectAgentLearning('executor', projectRoot);
    const first = loadProjectSkillAugmentation('executor', 'git-flow', projectRoot);
    await optimizeProjectAgentLearning('executor', projectRoot);
    expect(loadProjectSkillAugmentation('executor', 'git-flow', projectRoot)).toBe(first);
  });

  it('stamps a model-less pass so the cooldown applies to it too', async () => {
    for (const text of [
      '[skill: testing] Always run `pnpm vitest run` from the repository root.',
      '[skill: testing] Always attach the failing command output when reporting a broken build step.',
      '[skill: testing] Never assume a generated fixture is current; regenerate it before comparing.',
      '[skill: testing] Always add a focused spec alongside a fix under `packages/core/tests`.',
    ]) {
      capture('verifier', text);
    }
    expect(evaluateAutoOptimize('verifier', projectRoot, DEFAULT_AUTO_OPTIMIZE_POLICY)).toEqual({
      eligible: true,
      reason: 'pending-skills',
    });

    const result = await optimizeProjectAgentLearning('verifier', projectRoot);
    expect(result.status).toBe('no-llm');
    expect(loadProjectAgentLearningPolicy('verifier', projectRoot).lastOptimizeAt).toBeTruthy();
    expect(evaluateAutoOptimize('verifier', projectRoot, DEFAULT_AUTO_OPTIMIZE_POLICY)).toEqual({
      eligible: false,
      reason: 'cooling-down',
    });
  });

  it('does not lose the optimize stamp when a capture lands afterwards', () => {
    mkdirSync(path.join(projectRoot, '.wrongstack', 'agents', 'verifier'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.wrongstack', 'agents', 'verifier', 'learning.json'),
      JSON.stringify({
        enabled: true,
        lifetimeCaptureCount: 2,
        lastOptimizeAt: '2026-08-01T00:00:00.000Z',
      }),
      'utf8',
    );
    capture('verifier', VITEST_DIRECTIVE);
    const policy = loadProjectAgentLearningPolicy('verifier', projectRoot);
    expect(policy.lastOptimizeAt).toBe('2026-08-01T00:00:00.000Z');
    expect(policy.lifetimeCaptureCount).toBe(3);
  });
});

describe('learning stats', () => {
  it('reports how the buffer is performing, not only how big it is', () => {
    capture('verifier', VITEST_DIRECTIVE);
    capture(
      'verifier',
      'Always state the verification you actually performed rather than implying it.',
    );
    expect(getProjectAgentLearnStats('verifier', projectRoot).directiveHitRate).toBeNull();

    recordDirectiveOutcomes('verifier', '`pnpm vitest run`', true, projectRoot);
    recordDirectiveOutcomes('verifier', '`pnpm vitest run`', false, projectRoot);

    const stats = getProjectAgentLearnStats('verifier', projectRoot);
    expect(stats.appliedEntryCount).toBe(1);
    expect(stats.deadEntryCount).toBe(1);
    expect(stats.directiveHitRate).toBeCloseTo(0.5, 5);
  });
});
