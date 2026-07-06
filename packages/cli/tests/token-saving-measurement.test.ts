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
import { setupTools, getToolsForTier } from '../src/wiring/tools.js';
import { builtinToolsPack } from '@wrongstack/tools';

/**
 * MEASUREMENT TEST — empirical token-count audit of `tokenSavingMode` tiers.
 *
 * Builds the real system prompt at each tier using `setupTools()` (the same
 * path production uses) and reports:
 *   - char count of the joined prompt text
 *   - token estimate at 3.5 chars/token (the project's heuristic)
 *   - token estimate at 4.0 chars/token (Anthropic Claude closer-to-reality)
 *
 * Numbers print to stdout. The assertions below verify only the relative
 * ordering — `off` should be the largest prompt, all compacting tiers
 * smaller. We do NOT assert specific absolute numbers because tool descriptions
 * evolve; the doc estimates can be updated from this output.
 *
 * Run: `pnpm --filter @wrongstack/cli test -- token-saving-measurement.test.ts`
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'token-saving-measure-'));
  // Real git repo so `gitStatus()` takes the close path, not the 2s timeout.
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

function makeMemoryStore(): DefaultMemoryStore {
  return new DefaultMemoryStore({ paths: makeWpaths() });
}

function makeContainer() {
  const c = new Container();
  c.bind(TOKENS.Compactor, () => ({ compact: async () => ({ ok: true }) }));
  return c;
}

function fakeConfig(tier: string, overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'anthropic-test-model',
    features: {
      mcp: true,
      plugins: true,
      memory: true,
      modelsRegistry: true,
      skills: false, // skip skill loading for deterministic measurement
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
    ...overrides,
  } as Config;
}

function makeModelsRegistry() {
  return {
    getModel: async () => ({
      id: 'anthropic-test-model',
      capabilities: { maxContext: 200_000, tools: true, vision: false, reasoning: true },
    }),
    getProvider: () => undefined,
    listProviders: async () => [],
    suggestModel: async () => undefined,
    refresh: async () => undefined,
    listProvidersWithModels: async () => [],
  };
}

const RoughTokenEstimate = (text: string, charsPerToken = 3.5): number =>
  Math.max(1, Math.ceil(text.length / charsPerToken));

interface Measurement {
  tier: string;
  toolCount: number;
  promptChars: number;
  tokens35: number;
  tokens40: number;
  deltaCharsVsOff: number;
  deltaTokens35VsOff: number;
}

async function measureTier(tier: string): Promise<Measurement> {
  const toolRegistry = new ToolRegistry();
  const memoryStore = makeMemoryStore();
  const result = await setupTools({
    config: fakeConfig(tier),
    toolRegistry,
    modelsRegistry: makeModelsRegistry() as never,
    memoryStore,
    wpaths: makeWpaths(),
    projectRoot: tmp,
    cwd: tmp,
    container: makeContainer() as never,
  });
  const blocks = await result.systemPrompt;
  const joined = blocks.map((b) => b.text).join('\n');
  const toolCount = toolRegistry.list().length;
  return {
    tier,
    toolCount,
    promptChars: joined.length,
    tokens35: RoughTokenEstimate(joined, 3.5),
    tokens40: RoughTokenEstimate(joined, 4.0),
    deltaCharsVsOff: 0,
    deltaTokens35VsOff: 0,
  };
}

describe('token-saving measurement (empirical)', () => {
  it('measures prompt size at every tier and reports deltas', async () => {
    const tiers = ['off', 'minimal', 'light', 'medium', 'aggressive'];
    const results: Measurement[] = [];
    for (const tier of tiers) {
      results.push(await measureTier(tier));
    }
    // Compute deltas relative to 'off'.
    const off = results.find((r) => r.tier === 'off')!;
    for (const r of results) {
      r.deltaCharsVsOff = r.promptChars - off.promptChars;
      r.deltaTokens35VsOff = r.tokens35 - off.tokens35;
    }

    // Print a clear table.
    /* eslint-disable no-console */
    console.log('\n┌─────────────┬─────────┬────────────┬────────────┬────────────┬──────────────┬──────────────┐');
    console.log('│ Tier        │ Tools   │ Prompt ch. │ Tok (3.5c) │ Tok (4.0c) │ Δ chars      │ Δ tok (3.5c) │');
    console.log('├─────────────┼─────────┼────────────┼────────────┼────────────┼──────────────┼──────────────┤');
    for (const r of results) {
      const t = r.tier.padEnd(11);
      const tc = String(r.toolCount).padStart(7);
      const pc = String(r.promptChars).padStart(10);
      const t35 = String(r.tokens35).padStart(10);
      const t40 = String(r.tokens40).padStart(10);
      const dc = (r.deltaCharsVsOff >= 0 ? '+' : '') + String(r.deltaCharsVsOff).padStart(11);
      const dt = (r.deltaTokens35VsOff >= 0 ? '+' : '') + String(r.deltaTokens35VsOff).padStart(11);
      console.log(`│ ${t} │ ${tc} │ ${pc} │ ${t35} │ ${t40} │ ${dc} │ ${dt} │`);
    }
    console.log('└─────────────┴─────────┴────────────┴────────────┴────────────┴──────────────┴──────────────┘');
    /* eslint-enable no-console */

    // Tool counts per tier (sanity check).
    const byTier = (t: string) => results.find((r) => r.tier === t)!.toolCount;
    expect(byTier('off')).toBeGreaterThan(byTier('medium'));
    expect(byTier('medium')).toBeGreaterThan(byTier('minimal'));
    expect(byTier('minimal')).toBe(byTier('light')); // identical by design

    // 'off' must be the largest prompt — every compacting tier is smaller.
    const offChars = results.find((r) => r.tier === 'off')!.promptChars;
    for (const r of results) {
      if (r.tier === 'off') continue;
      expect(r.promptChars).toBeLessThan(offChars);
    }

    // Regression: `aggressive` must be meaningfully smaller than `off`.
    // Pre-fix (commit 145cdc23) measured a 62-token delta — essentially no
    // savings. The fix gates Common Patterns, Delegation, Mailbox, and MCP
    // guidance on tier !== 'aggressive'. We expect at least 800 tokens of
    // savings; pinning it at >= 500 to leave headroom for future tool/skill
    // growth while still catching a full revert.
    const aggressiveDelta = results.find((r) => r.tier === 'aggressive')!.deltaTokens35VsOff;
    expect(aggressiveDelta).toBeLessThanOrEqual(-500);
  });

  it('cross-checks getToolsForTier counts against the real builtinTools array', () => {
    const allTools = builtinToolsPack.tools ?? [];
    const allNames = allTools.map((t) => t.name).sort();
    // Sanity: this codebase has grown beyond the original 36 tools. Whatever
    // the current number, getToolsForTier must respect the TIER1/2/3 split.
    const tier1 = allTools.filter((t) =>
      [
        'read', 'write', 'edit', 'bash', 'grep', 'glob',
        'diff', 'patch', 'json', 'search',
      ].includes(t.name),
    );
    expect(getToolsForTier('minimal', allTools)).toHaveLength(tier1.length);
    expect(getToolsForTier('light', allTools)).toHaveLength(tier1.length);
    // The medium tier includes TIER1 + TIER2; we don't pin the absolute count
    // (it grows as new tools are added) but it must be >= tier1 and > off's count - 1
    // (off minus TIER3-only tools).
    const off = allTools.length;
    const medium = getToolsForTier('medium', allTools).length;
    const aggressive = getToolsForTier('aggressive', allTools).length;
    expect(medium).toBeGreaterThanOrEqual(tier1.length);
    expect(medium).toBeLessThan(off); // off has more tools (includes TIER3)
    expect(aggressive).toBeGreaterThanOrEqual(medium);
    expect(aggressive).toBeLessThan(off + 1); // never exceeds off by more than tier3-excluded
    // Check that 'off' returns the full list verbatim
    expect(getToolsForTier('off', allTools).map((t) => t.name).sort()).toEqual(allNames);
  });
});
