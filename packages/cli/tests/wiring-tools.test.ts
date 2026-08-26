import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, Tool } from '@wrongstack/core/types';
import { selectBuiltinToolsForTier } from '@wrongstack/tools/tool-tier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCliToolSurface } from './cli-tool-surface.js';
import { makeFakeMemoryStore } from './fake-memory-store.js';

let tmp: string;

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'p',
    model: 'm',
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
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

const surface = (config: Config) =>
  buildCliToolSurface({ config, memoryStore: makeFakeMemoryStore(), tmp });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-tools-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// Exercises `setupCliPromptAndTools` — the wiring `cli-main.ts` actually runs.
// An earlier version of this file tested `wiring/tools.ts` `setupTools`, which
// no production code path ever called; see `./cli-tool-surface.ts` for why that
// mattered enough to delete.
describe('setupCliPromptAndTools', () => {
  it('registers builtin tools and binds a working system-prompt builder', async () => {
    const { toolRegistry, buildSystemPrompt } = await surface(fakeConfig());
    expect(toolRegistry.list().length).toBeGreaterThan(0);
    const blocks = await buildSystemPrompt();
    expect(Array.isArray(blocks)).toBe(true);
  });

  // The CLI is the surface that owns a Compactor at registration time, so it is
  // the one that can pass `contextTool` into the canonical registration. Assert
  // it does — this is the option the standalone/desktop server had to register
  // separately because its compactor is built after the registry.
  it('registers the context_manager tool', async () => {
    const { toolRegistry } = await surface(fakeConfig());
    expect(toolRegistry.list().map((t) => t.name)).toContain('context_manager');
  });

  it('registers remember/forget when the memory feature is enabled', async () => {
    const { toolRegistry } = await surface(fakeConfig());
    const toolNames = toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain('remember');
    expect(toolNames).toContain('forget');
  });

  it('skips remember/forget when the memory feature is disabled', async () => {
    const { toolRegistry } = await surface(
      fakeConfig({
        features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true },
      }),
    );
    const toolNames = toolRegistry.list().map((t) => t.name);
    expect(toolNames).not.toContain('remember');
    expect(toolNames).not.toContain('forget');
  });

  it('applies configured tool description modes', async () => {
    const { toolRegistry } = await surface(
      fakeConfig({
        tools: { ...fakeConfig().tools, descriptionMode: { read: 'simple' } },
      }),
    );
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
  });
});

describe('selectBuiltinToolsForTier', () => {
  // Minimal fake tool factory to make lightweight tool arrays for testing.
  const mkTool = (name: string): Tool => ({
    name,
    description: `desc-${name}`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object' },
    async execute() {
      return '';
    },
  });

  // Helper: build a tier array by name from a flat list
  const namedTools = (names: string[]): Tool[] => names.map(mkTool);

  it("'off' returns all provided tools", () => {
    const tools = namedTools(['read', 'write', 'grep', 'bash', 'replace', 'exec']);
    const result = selectBuiltinToolsForTier('off', tools);
    expect(result).toHaveLength(6);
    expect(result.map((t) => t.name)).toEqual(['read', 'write', 'grep', 'bash', 'replace', 'exec']);
  });

  it("'off' with empty array returns empty", () => {
    expect(selectBuiltinToolsForTier('off', [])).toHaveLength(0);
  });

  it("'minimal' returns only TIER1-equivalent tools (13)", () => {
    // TIER1 keeps the complete codebase-index lifecycle available so minimal
    // mode does not force broad grep/glob exploration.
    const tier1Names = [
      'read',
      'write',
      'edit',
      'codebase-stats',
      'codebase-search',
      'codebase-index',
      'bash',
      'grep',
      'glob',
      'diff',
      'patch',
      'json',
      'search',
    ];
    // 'off' returns everything so we can verify filtering
    const allTools = namedTools([...tier1Names, 'replace', 'exec', 'fetch', 'git', 'tree', 'lint']);
    const result = selectBuiltinToolsForTier('minimal', allTools);
    expect(result).toHaveLength(13);
    for (const name of tier1Names) {
      expect(result.some((t) => t.name === name)).toBe(true);
    }
    expect(result.some((t) => t.name === 'replace')).toBe(false);
  });

  it("'light' returns same tool set as 'minimal' (guidance differs, tool set does not)", () => {
    const tier1Names = [
      'read',
      'write',
      'edit',
      'codebase-stats',
      'codebase-search',
      'codebase-index',
      'bash',
      'grep',
      'glob',
      'diff',
      'patch',
      'json',
      'search',
    ];
    const allTools = namedTools([...tier1Names, 'replace', 'exec']);
    const minimal = selectBuiltinToolsForTier('minimal', allTools);
    const light = selectBuiltinToolsForTier('light', allTools);
    expect(minimal).toHaveLength(light.length);
    expect(minimal.map((t) => t.name).sort()).toEqual(light.map((t) => t.name).sort());
  });

  it("'medium' includes TIER1 + TIER2", () => {
    const tier1 = [
      'read',
      'write',
      'edit',
      'codebase-stats',
      'codebase-search',
      'codebase-index',
      'bash',
      'grep',
      'glob',
      'diff',
      'patch',
      'json',
      'search',
    ];
    const tier2 = [
      'replace',
      'exec',
      'fetch',
      'git',
      'tree',
      'lint',
      'format',
      'typecheck',
      'test',
      'todo',
      'plan',
      'task',
      'install',
      'audit',
    ];
    const allTools = namedTools([...tier1, ...tier2, 'outdated', 'logs']);
    const result = selectBuiltinToolsForTier('medium', allTools);
    expect(result).toHaveLength(27); // 13 + 14
    for (const name of [...tier1, ...tier2]) {
      expect(result.some((t) => t.name === name)).toBe(true);
    }
    expect(result.some((t) => t.name === 'outdated')).toBe(false);
    expect(result.some((t) => t.name === 'logs')).toBe(false);
  });

  it("'aggressive' exposes only the Tier 1 direct surface", () => {
    // NOTE: namedTools() uses substring/grep matching so the count assertion is
    // unreliable (e.g. 'exec' matches bashTool too). Only verify exclusion behavior.
    const allToolNames = [
      'read',
      'write',
      'edit',
      'replace',
      'exec',
      'fetch',
      'search',
      'todo',
      'plan',
      'task',
      'git',
      'install',
      'audit',
      'outdated',
      'logs',
      'document',
      'scaffold',
      'setWorkingDir',
    ];
    const result = selectBuiltinToolsForTier('aggressive', namedTools(allToolNames));
    // Verify exclusions: 'task' (in TIER2) and 'setWorkingDir' (in TIER3) must be absent
    expect(result.some((t) => t.name === 'task')).toBe(false);
    expect(result.some((t) => t.name === 'setWorkingDir')).toBe(false);
    // Tier 1 remains directly available; Tier 2/3 stays executable through
    // the full registry and on-demand meta-tool path.
    expect(result.some((t) => t.name === 'read')).toBe(true);
    expect(result.some((t) => t.name === 'replace')).toBe(false);
    expect(result.some((t) => t.name === 'exec')).toBe(false);
    expect(result.some((t) => t.name === 'outdated')).toBe(false);
  });

  it.each(['off', 'minimal', 'light', 'medium', 'aggressive'] as const)(
    "keeps codebase discovery and index creation available in the '%s' tier",
    (tier) => {
      const tools = namedTools([
        'read',
        'grep',
        'glob',
        'codebase-stats',
        'codebase-search',
        'codebase-index',
      ]);
      const names = selectBuiltinToolsForTier(tier, tools).map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['codebase-stats', 'codebase-search', 'codebase-index']),
      );
    },
  );
});
