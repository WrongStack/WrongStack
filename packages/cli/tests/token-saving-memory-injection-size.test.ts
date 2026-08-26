import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
import type { Config } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCliToolSurface } from './cli-tool-surface.js';
import { makeFakeMemoryStore } from './fake-memory-store.js';

/**
 * Regression — memory injection size at every tier.
 *
 * Pins the relative size of the `# Relevant Memory` block across the 5
 * tiers, so a future change to `buildMemoryAndSkills()` (in
 * `packages/core/src/core/system-prompt-builder.ts`) doesn't silently
 * double the per-prompt memory cost.
 *
 * Compact memory at `aggressive` was considered (would close ~150 tokens
 * of the savings gap to the original "~4-5k" doc claim) but rejected:
 *   1. Memory is signal, not overhead — at the tier where context is most
 *      pressured, the model needs the most recall, not less.
 *   2. The relevance scorer already filters to top-K — cutting from 8 to
 *      3 drops the 4th-8th most relevant facts the model knows.
 *   3. The savings (~150 tokens / 4% of total) wouldn't close the doc
 *      gap anyway — that gap is structural (TIER3 tools + skill bodies).
 *
 * See commit history: docs/token-saving-tiers-design.md documents the
 * "different optimization axes" relationship between `medium` (fewer
 * tools + full guidance) and `aggressive` (many tools + compact guidance).
 *
 * Run: pnpm vitest run packages/cli/tests/token-saving-memory-injection-size.test.ts
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'token-saving-mem-'));
  execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function fakeConfig(tier: string): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'anthropic-test-model',
    features: {
      mcp: true,
      plugins: true,
      memory: true,
      modelsRegistry: true,
      skills: false,
      tokenSavingMode: tier as never,
    },
    tools: {
      defaultExecutionStrategy: 'smart',
      maxIterations: 100,
      iterationTimeoutMs: 300_000,
      sessionTimeoutMs: 1_800_000,
      perIterationOutputCapBytes: 100_000,
      descriptionMode: {},
    },
  } as unknown as Config;
}

async function measureMemoryBlock(
  tier: string,
): Promise<{ tier: string; total: number; memory: number }> {
  const memoryStore = makeFakeMemoryStore();

  // Seed 8 bash-tagged entries — the relevance scorer ranks by tag/tool
  // overlap, so tagging every entry with 'bash' (the always-present tool)
  // ensures all 8 land in top-K at every tier.
  await memoryStore.remember(
    'Use pnpm not npm — bash builds assume pnpm-lock.yaml exists',
    'project-memory',
    { type: 'convention', priority: 'critical', tags: ['bash', 'build'] },
  );
  await memoryStore.remember(
    'Use bash with `set -euo pipefail` for shell scripts',
    'project-memory',
    { type: 'convention', priority: 'high', tags: ['bash', 'style'] },
  );
  await memoryStore.remember(
    'Bash tools must use the bash tool — never exec inline',
    'project-memory',
    { type: 'decision', priority: 'critical', tags: ['bash', 'arch'] },
  );
  await memoryStore.remember(
    'Project root is bash-friendly: paths use forward slashes',
    'project-memory',
    { type: 'fact', priority: 'medium', tags: ['bash'] },
  );
  await memoryStore.remember('See docs/bash-tool.md for bash usage patterns', 'project-memory', {
    type: 'reference',
    priority: 'high',
    tags: ['bash', 'docs'],
  });
  await memoryStore.remember('Bash completion is bash 4+ only', 'project-memory', {
    type: 'fact',
    priority: 'medium',
    tags: ['bash'],
  });
  await memoryStore.remember(
    'User prefers bash over sh for interactive scripts',
    'project-memory',
    { type: 'preference', priority: 'low', tags: ['bash', 'user'] },
  );
  await memoryStore.remember('Never pipe secrets into bash -c', 'project-memory', {
    type: 'anti_pattern',
    priority: 'high',
    tags: ['bash', 'security'],
  });

  const { toolRegistry } = await buildCliToolSurface({
    config: fakeConfig(tier),
    memoryStore,
    tmp,
    modelCapabilities: {
      maxContextTokens: 200_000,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true,
    },
  });

  // Deliberately opt IN to the static section. Every production builder passes
  // `injectMemory: false` — SAGE's turn middleware is the single memory
  // channel — so the shipped prompt carries no `# Relevant Memory` block at
  // all (pinned by the second test below). What this measurement guards is
  // `buildMemoryAndSkills()` itself, for any consumer that does opt in: it
  // must not silently double in size. The tool surface still comes from the
  // real CLI wiring so each tier's prompt is measured against its real tools.
  const builder = new DefaultSystemPromptBuilder({
    memoryStore: memoryStore as never,
    injectMemory: true,
    modeId: 'default',
    modePrompt: '',
    tokenSavingMode: fakeConfig(tier).features.tokenSavingMode,
    instructionPaths: { globalDir: tmp, projectDir: tmp },
  });
  const blocks = await builder.build({
    cwd: tmp,
    projectRoot: tmp,
    tools: toolRegistry.listForProvider(),
    catalogTools: toolRegistry.list(),
    provider: 'anthropic',
    model: 'anthropic-test-model',
  });
  const joined = blocks.map((b) => b.text).join('\n');
  const memStart = joined.indexOf('# Relevant Memory');
  const memEnd = memStart >= 0 ? joined.indexOf('\n\n', memStart + 18) : -1;
  const memoryBlock = memStart >= 0 && memEnd > memStart ? joined.slice(memStart, memEnd) : '';
  return { tier, total: joined.length, memory: memoryBlock.length };
}

describe('memory injection size by tier', () => {
  it('pins relative memory-block sizes across the 5 tiers', async () => {
    const tiers = ['off', 'minimal', 'light', 'medium', 'aggressive'];
    const results: { tier: string; total: number; memory: number }[] = [];
    for (const tier of tiers) {
      results.push(await measureMemoryBlock(tier));
    }

    // Sanity: every tier emits a memory block (memory feature is enabled).
    for (const r of results) {
      expect(r.memory).toBeGreaterThan(0);
    }

    // 'minimal' must be smallest (3 items, compact form — no badges/tags).
    const bySize = [...results].sort((a, b) => a.memory - b.memory);
    expect(bySize[0]?.tier).toBe('minimal');

    // 'off' / 'medium' use the full memory format and should remain roughly
    // equal. Allow 50% slack for scoring-order and entry-length variance.
    const full = ['off', 'medium']
      .map((t) => results.find((r) => r.tier === t)!)
      .map((r) => r.memory);
    const maxFull = Math.max(...full);
    const minFull = Math.min(...full);
    expect(minFull).toBeGreaterThan(maxFull * 0.5);

    // Aggressive is the maximum-reduction tier: its compact three-item memory
    // block must remain materially smaller than both full-format tiers.
    const aggressive = results.find((r) => r.tier === 'aggressive')!;
    expect(aggressive.memory).toBeLessThan(Math.min(...full) * 0.75);
  });

  // The single-memory-channel invariant. Every production builder
  // (`cli/src/boot/system-prompt-builder.ts`, `boot/tui-project-switch.ts`,
  // `runtime/src/container.ts`, and both webui-server sites) passes
  // `injectMemory: false` so SAGE's turn middleware stays the only injector.
  // The one builder that omitted it lived in `wiring/tools.ts`, which no
  // production path called — and the measurement above used to be taken
  // through THAT builder, so it reported healthy numbers for a block the
  // product never emits. Pin the shipped behaviour directly.
  it('the shipped CLI prompt carries no static memory section', async () => {
    const memoryStore = makeFakeMemoryStore();
    await memoryStore.remember('Use pnpm not npm', 'project-memory', {
      type: 'convention',
      priority: 'critical',
      tags: ['bash'],
    });
    const { buildSystemPrompt } = await buildCliToolSurface({
      config: fakeConfig('off'),
      memoryStore,
      tmp,
    });
    const joined = (await buildSystemPrompt()).map((b) => b.text).join('\n');
    expect(joined).not.toContain('# Relevant Memory');
  });
});
