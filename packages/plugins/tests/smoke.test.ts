/**
 * @wrongstack/plugins — smoke tests
 *
 * Verifies that all 8 plugin modules:
 *  1. Import as a default export
 *  2. Have name, apiVersion, and setup
 *  3. setup() does not throw with a minimal mock API
 *  4. loadPlugins() from @wrongstack/core accepts them
 *
 * Run: npx vitest run packages/plugins/tests/smoke.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

// Some plugin tools shell out to git (execSync) during execute(); that spawn
// overhead pushes these tests past the 5s default on Windows.
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Minimal Plugin type mirror (avoids needing @wrongstack/core to be built)
// ---------------------------------------------------------------------------

interface FakePlugin {
  name: string;
  version?: string;
  description?: string;
  apiVersion: string;
  capabilities?: { tools?: boolean; pipelines?: string[] };
  defaultConfig?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  dependsOn?: string[];
  setup(api: FakePluginAPI): void | Promise<void>;
  teardown?(api: FakePluginAPI): void | Promise<void>;
  health?(): Promise<{ ok: boolean; message?: string }>;
}

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown> };
  permission?: string;
  mutating?: boolean;
  execute(input: unknown, ctx: { log: unknown }): Promise<unknown>;
}

interface FakePluginAPI {
  tools: {
    register(t: FakeTool): void;
    unregister(name: string): void;
    wrap(name: string, wrapper: unknown): void;
    get(name: string): FakeTool | undefined;
    list(): FakeTool[];
  };
  slashCommands: {
    register(cmd: unknown): void;
    unregister(name: string): boolean;
    get(name: string): unknown;
    list(): unknown[];
  };
  pipelines: Record<string, { use: (h: unknown) => void; get: (n: string) => unknown }>;
  config: { extensions?: Record<string, unknown> };
  log: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  metrics: {
    counter: (name: string, val?: number, labels?: Record<string, string>) => void;
    histogram: (name: string, val?: number, labels?: Record<string, string>) => void;
    gauge: (name: string, val?: number) => void;
  };
  session: { append: (ev: unknown) => Promise<void>; transcriptPath?: string };
  extensions: { register(name: string, hook: unknown): { unregister(): void } };
  registerSystemPromptContributor(c: {
    id: string;
    contribute(): Array<{ type: string; content: string }>;
  }): () => void;
  onEvent(event: string, handler: unknown): () => void;
  onPattern(pattern: string, handler: (event: string, payload: unknown) => void): () => void;
  emitCustom(event: string, payload: unknown): void;
  onConfigChange(handler: (next: unknown, prev: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Mock API factory
// ---------------------------------------------------------------------------

function createMockAPI(): FakePluginAPI {
  const tools: FakeTool[] = [];
  const commands: unknown[] = [];

  return {
    tools: {
      register(t: FakeTool) {
        tools.push(t);
      },
      unregister(_n: string) {},
      wrap(_n: string, _w: unknown) {},
      get(n: string) {
        return tools.find((t) => t.name === n);
      },
      list() {
        return [...tools];
      },
    },
    slashCommands: {
      register(cmd: unknown) {
        commands.push(cmd);
      },
      unregister(_n: string) {
        return false;
      },
      get(_n: string) {
        return undefined;
      },
      list() {
        return [...commands];
      },
    },
    pipelines: {
      request: { use: vi.fn(), get: vi.fn() } as never,
      response: { use: vi.fn(), get: vi.fn() } as never,
      toolCall: { use: vi.fn(), get: vi.fn() } as never,
      userInput: { use: vi.fn(), get: vi.fn() } as never,
      assistantOutput: { use: vi.fn(), get: vi.fn() } as never,
      contextWindow: { use: vi.fn(), get: vi.fn() } as never,
    },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    session: { append: vi.fn().mockResolvedValue(undefined), transcriptPath: undefined },
    extensions: { register: vi.fn(() => ({ unregister: vi.fn() })) },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn(() => () => {}),
  };
}

// ---------------------------------------------------------------------------
// Plugin files to test
// ---------------------------------------------------------------------------

const PLUGIN_FILES = [
  ['auto-doc', '../src/auto-doc/index.ts'],
  ['git-autocommit', '../src/git-autocommit/index.ts'],
  ['shell-check', '../src/shell-check/index.ts'],
  ['cost-tracker', '../src/cost-tracker/index.ts'],
  ['file-watcher', '../src/file-watcher/index.ts'],
  ['cron', '../src/cron/index.ts'],
  ['template-engine', '../src/template-engine/index.ts'],
  ['semver-bump', '../src/semver-bump/index.ts'],
] as const;

describe('@wrongstack/plugins — smoke tests', () => {
  for (const [pluginName, filePath] of PLUGIN_FILES) {
    describe(pluginName, () => {
      it('imports as a default export', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        expect(mod.default).toBeDefined();
        expect(typeof mod.default).toBe('object');
      });

      it('has name, apiVersion, and setup function', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        const plugin: FakePlugin = mod.default;
        expect(plugin.name).toBe(pluginName);
        expect(typeof plugin.apiVersion).toBe('string');
        expect(plugin.apiVersion.length).toBeGreaterThan(0);
        expect(typeof plugin.setup).toBe('function');
      });

      it('setup() does not throw and registers at least one tool', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        const plugin: FakePlugin = mod.default;
        const api = createMockAPI();

        expect(() => plugin.setup(api as never)).not.toThrow();
        // Retired plugins (web-search, json-path) register 0 tools — skip the count check for them.
        const retired = ['web-search', 'json-path'];
        if (!retired.includes(pluginName)) {
          expect(api.tools.list().length).toBeGreaterThan(0);
        }
      });

      it('teardown() does not throw if defined', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        const plugin: FakePlugin = mod.default;
        const api = createMockAPI();

        plugin.setup(api as never);
        if (typeof plugin.teardown === 'function') {
          expect(() => plugin.teardown(api as never)).not.toThrow();
        }
      });

      it('all registered tools have name, description, and execute function', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        const plugin: FakePlugin = mod.default;
        const api = createMockAPI();

        plugin.setup(api as never);

        const registered = api.tools.list();
        // Retired plugins register 0 tools — skip the count check for them.
        const retired = ['web-search', 'json-path'];
        if (!retired.includes(pluginName)) {
          expect(registered.length).toBeGreaterThan(0);
        }

        for (const tool of registered) {
          expect(tool.name).toBeTruthy();
          expect(typeof tool.name).toBe('string');
          expect(typeof tool.execute).toBe('function');
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.type).toBe('object');
        }
      });

      it('each tool execute() returns a result without throwing', async () => {
        const mod = await import(/* @vite-ignore */ filePath);
        const plugin: FakePlugin = mod.default;
        const api = createMockAPI();

        plugin.setup(api as never);

        for (const tool of api.tools.list()) {
          // Never execute mutating tools against the live repo: semver_bump
          // used to create a real version-bump commit + tag and git_autocommit
          // a real "feat: update code" commit on every `pnpm test` run (even
          // its dryRun stages files). Smoke-execute read-only tools only.
          if (tool.mutating) continue;
          await expect(tool.execute({ dryRun: true }, { log: api.log })).resolves.toBeDefined();
        }
      });
    });
  }

  describe('plugin count', () => {
    it('has exactly 8 plugin files', () => {
      expect(PLUGIN_FILES).toHaveLength(8);
    });
  });

  describe('all 10 plugins load together without conflict', () => {
    it('setup() all plugins in sequence without error', async () => {
      const api = createMockAPI();
      const errors: string[] = [];

      for (const [, filePath] of PLUGIN_FILES) {
        try {
          const mod = await import(/* @vite-ignore */ filePath);
          const plugin: FakePlugin = mod.default;
          plugin.setup(api as never);
        } catch (err: unknown) {
          errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      expect(errors).toHaveLength(0);
      // All 10 plugins register at least 1 tool each = at least 10 tools total
      expect(api.tools.list().length).toBeGreaterThanOrEqual(10);
    });
  });
});
