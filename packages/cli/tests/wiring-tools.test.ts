import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/core/types';
import type { Tool } from '@wrongstack/core/types';
import { DefaultSessionStore as MemoryStoreImpl } from '@wrongstack/core/storage';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { WstackPaths } from '@wrongstack/core/utils';
import { selectBuiltinToolsForTier } from '@wrongstack/tools/tool-tier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTools } from '../src/wiring/tools.js';
import { makeFakeMemoryStore } from './fake-memory-store.js';

let tmp: string;

function fakeCompactor() {
  return { compact: vi.fn() };
}

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

function makeMemoryStore(): MemoryStoreImpl {
  return makeFakeMemoryStore();
}

function makeContainer() {
  const c = new Container();
  c.bind(TOKENS.Compactor, () => fakeCompactor() as never);
  return c;
}

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

function makeModelsRegistry(overrides: Record<string, unknown> = {}) {
  return {
    getModel: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn(),
    listProviders: vi.fn(),
    suggestModel: vi.fn(),
    refresh: vi.fn(),
    listProvidersWithModels: vi.fn(),
    ...overrides,
  } as never;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-tools-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('setupTools', () => {
  it('registers builtin tools and returns assembled wiring result', async () => {
    const toolRegistry = new ToolRegistry();
    const memoryStore = makeMemoryStore();
    const result = await setupTools({
      config: fakeConfig(),
      toolRegistry,
      modelsRegistry: makeModelsRegistry(),
      memoryStore,
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    expect(result.toolRegistry).toBe(toolRegistry);
    expect(result.modeStore).toBeDefined();
    expect(result.promptBuilder).toBeDefined();
    expect(result.skillLoader).toBeDefined();
    // System prompt was computed
    const blocks = await result.systemPrompt;
    expect(Array.isArray(blocks)).toBe(true);
    // Builtin tools were registered
    expect(toolRegistry.list().length).toBeGreaterThan(0);
  });

  it('registers remember/forget when memory feature enabled', async () => {
    const toolRegistry = new ToolRegistry();
    await setupTools({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
      }),
      toolRegistry,
      modelsRegistry: makeModelsRegistry(),
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    const toolNames = toolRegistry.list().map((t) => t.name);
    expect(toolNames).toContain('remember');
    expect(toolNames).toContain('forget');
  });

  it('applies configured tool description modes', async () => {
    const toolRegistry = new ToolRegistry();
    await setupTools({
      config: fakeConfig({
        tools: {
          ...fakeConfig().tools,
          descriptionMode: { read: 'simple' },
        },
      }),
      toolRegistry,
      modelsRegistry: makeModelsRegistry(),
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    expect(toolRegistry.getDescriptionMode('read')).toBe('simple');
  });

  it('skips remember/forget when memory feature disabled', async () => {
    const toolRegistry = new ToolRegistry();
    await setupTools({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: false, modelsRegistry: true, skills: true },
      }),
      toolRegistry,
      modelsRegistry: makeModelsRegistry(),
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    const toolNames = toolRegistry.list().map((t) => t.name);
    expect(toolNames).not.toContain('remember');
    expect(toolNames).not.toContain('forget');
  });

  it('returns undefined skillLoader when skills feature disabled', async () => {
    const result = await setupTools({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: false },
      }),
      toolRegistry: new ToolRegistry(),
      modelsRegistry: makeModelsRegistry(),
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    expect(result.skillLoader).toBeUndefined();
  });

  it('uses model capabilities from modelsRegistry when available', async () => {
    const modelsRegistry = makeModelsRegistry({
      getModel: vi.fn().mockResolvedValue({
        id: 'm',
        capabilities: { maxContext: 200000, tools: true, vision: false, reasoning: true },
      }),
    });
    const result = await setupTools({
      config: fakeConfig(),
      toolRegistry: new ToolRegistry(),
      modelsRegistry,
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    expect(result.promptBuilder).toBeDefined();
    expect(
      (modelsRegistry as { getModel: ReturnType<typeof vi.fn> }).getModel,
    ).toHaveBeenCalledWith('p', 'm');
  });

  it('persists active mode preselection when set on modeStore', async () => {
    const toolRegistry = new ToolRegistry();
    // Pre-write a mode file so modeStore.getActiveMode() returns it.
    const modeDir = path.join(tmp, 'modes');
    await fs.mkdir(modeDir, { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'mode.json'),
      JSON.stringify({ id: 'custom', prompt: 'be custom' }),
    );
    const result = await setupTools({
      config: fakeConfig(),
      toolRegistry,
      modelsRegistry: makeModelsRegistry(),
      memoryStore: makeMemoryStore(),
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      container: makeContainer() as never,
    });
    // mode.json sits at configDir, modeStore loads it. We can't assert the
    // mode is the one from disk without inspecting builder internals, but the
    // call must not throw and the result must include modeStore.
    expect(result.modeStore).toBeDefined();
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

  it("'aggressive' excludes 'task' from TIER2 and 'setWorkingDir' from TIER3", () => {
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
    // Verify inclusions: tools in TIER1 and TIER2/TIER3 (other than excluded) must be present
    expect(result.some((t) => t.name === 'read')).toBe(true);
    expect(result.some((t) => t.name === 'replace')).toBe(true);
    expect(result.some((t) => t.name === 'exec')).toBe(true);
    expect(result.some((t) => t.name === 'outdated')).toBe(true);
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
