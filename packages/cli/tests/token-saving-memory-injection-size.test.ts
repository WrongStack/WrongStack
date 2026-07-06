import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Container,
  type Config,
  DefaultMemoryStore,
  TOKENS,
  ToolRegistry,
  type WstackPaths,
} from '@wrongstack/core';
import { setupTools } from '../src/wiring/tools.js';

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

function makeWpaths(): WstackPaths {
  return {
    configDir: tmp,
    globalConfig: path.join(tmp, 'config.json'),
    projectDir: tmp,
    projectSessions: tmp,
    globalRoot: tmp,
    logFile: path.join(tmp, 'log.txt'),
    historyFile: path.join(tmp, 'history'),
    modelsCache: path.join(tmp, 'models.json'),
    inProjectAgentsFile: path.join(tmp, 'AGENTS.md'),
    projectMemory: path.join(tmp, 'project-memory.md'),
    globalMemory: path.join(tmp, 'global-memory.md'),
  } as WstackPaths;
}

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
  } as Config;
}

function fakeCompactor() {
  return { compact: async () => ({ ok: true }) };
}

async function measureMemoryBlock(tier: string): Promise<{ tier: string; total: number; memory: number }> {
  const toolRegistry = new ToolRegistry();
  const memoryStore = new DefaultMemoryStore({ paths: makeWpaths() });
  const container = new Container();
  container.bind(TOKENS.Compactor, () => fakeCompactor());

  // Seed 8 bash-tagged entries — the relevance scorer ranks by tag/tool
  // overlap, so tagging every entry with 'bash' (the always-present tool)
  // ensures all 8 land in top-K at every tier.
  await memoryStore.remember('Use pnpm not npm — bash builds assume pnpm-lock.yaml exists', 'project-memory', { type: 'convention', priority: 'critical', tags: ['bash', 'build'] });
  await memoryStore.remember('Use bash with `set -euo pipefail` for shell scripts', 'project-memory', { type: 'convention', priority: 'high', tags: ['bash', 'style'] });
  await memoryStore.remember('Bash tools must use the bash tool — never exec inline', 'project-memory', { type: 'decision', priority: 'critical', tags: ['bash', 'arch'] });
  await memoryStore.remember('Project root is bash-friendly: paths use forward slashes', 'project-memory', { type: 'fact', priority: 'medium', tags: ['bash'] });
  await memoryStore.remember('See docs/bash-tool.md for bash usage patterns', 'project-memory', { type: 'reference', priority: 'high', tags: ['bash', 'docs'] });
  await memoryStore.remember('Bash completion is bash 4+ only', 'project-memory', { type: 'fact', priority: 'medium', tags: ['bash'] });
  await memoryStore.remember('User prefers bash over sh for interactive scripts', 'project-memory', { type: 'preference', priority: 'low', tags: ['bash', 'user'] });
  await memoryStore.remember('Never pipe secrets into bash -c', 'project-memory', { type: 'anti_pattern', priority: 'high', tags: ['bash', 'security'] });

  const result = await setupTools({
    config: fakeConfig(tier),
    toolRegistry,
    modelsRegistry: {
      getModel: async () => ({
        id: 'anthropic-test-model',
        capabilities: { maxContext: 200_000, tools: true, vision: false, reasoning: true },
      }),
    } as never,
    memoryStore,
    wpaths: makeWpaths(),
    projectRoot: tmp,
    cwd: tmp,
    container: container as never,
  });
  const blocks = await result.systemPrompt;
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

    // 'off' / 'medium' / 'aggressive' must all be roughly equal — they
    // share the same 8-item full format. Allow 50% slack to absorb
    // scoring-order variance and any future entry-length drift.
    const full = ['off', 'medium', 'aggressive']
      .map((t) => results.find((r) => r.tier === t)!)
      .map((r) => r.memory);
    const maxFull = Math.max(...full);
    const minFull = Math.min(...full);
    expect(minFull).toBeGreaterThan(maxFull * 0.5);

    // Regression — `aggressive` must NOT compact memory. If a future
    // change accidentally drops it to 3-item compact form, this catches it.
    const aggressive = results.find((r) => r.tier === 'aggressive')!;
    expect(aggressive.memory).toBeGreaterThan(bySize[0]!.memory * 2);
  });
});
