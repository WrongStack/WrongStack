import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FallbackProfileManager } from '@wrongstack/core/agent';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import { DefaultConfigStore, getSessionRegistry } from '@wrongstack/core/storage';
import { DirectoryPermissionPolicy } from '@wrongstack/core/security';
import type { SessionStore } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { SqliteMemoryPort } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultContainer } from '../src/container.js';

const mockConfig = {
  version: 1,
  provider: 'anthropic',
  model: 'anthropic-test-model',
  log: { level: 'info' as const },
  tools: {
    maxIterations: 100,
    iterationTimeoutMs: 300000,
    defaultExecutionStrategy: 'smart' as const,
    perIterationOutputCapBytes: 100000,
    autoExtendLimit: true,
    sessionTimeoutMs: 1800000,
  },
  context: {
    warnThreshold: 0.6,
    softThreshold: 0.75,
    hardThreshold: 0.9,
    preserveK: 10,
    eliseThreshold: 2000,
    autoCompact: true,
  },
  features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
} as any;

const runtimeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-runtime-container-'));

const mockWpaths = {
  projectRoot: runtimeProjectRoot,
  projectSessions: path.join(runtimeProjectRoot, 'sessions'),
  configDir: '/tmp/config',
  projectTrust: path.join(runtimeProjectRoot, 'trust.json'),
  globalRoot: '/home/user/.wrongstack',
  inProjectAgentsFile: '/repo/.wrongstack/AGENTS.md',
  projectMemory: '/repo/.wrongstack/memory.md',
  globalMemory: '/home/user/.wrongstack/memory.md',
} as any;

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
} as any;
const mockModels = {
  getProvider: () => Promise.resolve(null),
  getModel: () => Promise.resolve(null),
} as any;

describe('createDefaultContainer', () => {
  it('returns a Container instance', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    expect(c).toBeInstanceOf(Container);
  });

  it('binds ConfigStore with the provided config', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    const store = c.resolve(TOKENS.ConfigStore);
    expect(store).toBeInstanceOf(DefaultConfigStore);
  });

  it('binds one live FallbackProfileManager and reloads it on ConfigStore updates', () => {
    const c = createDefaultContainer({
      config: {
        ...mockConfig,
        providers: {
          anthropic: { type: 'anthropic', apiKey: 'test', models: ['old-model', 'new-model'] },
        },
        fallbackProfiles: { old: ['anthropic/old-model'] },
      },
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    const store = c.resolve(TOKENS.ConfigStore);
    const manager = c.resolve(TOKENS.FallbackProfileManager);

    expect(manager).toBeInstanceOf(FallbackProfileManager);
    expect(c.resolve(TOKENS.FallbackProfileManager)).toBe(manager);
    expect(manager.hasProfile('old')).toBe(true);

    store.update({ fallbackProfiles: { new: ['anthropic/new-model'] } });

    expect(c.resolve(TOKENS.FallbackProfileManager)).toBe(manager);
    expect(manager.hasProfile('old')).toBe(false);
    expect(manager.resolve('new')).toMatchObject([{ providerId: 'anthropic', model: 'new-model' }]);
  });

  it('binds all required tokens', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    expect(c.has(TOKENS.Logger)).toBe(true);
    expect(c.has(TOKENS.FallbackProfileManager)).toBe(true);
    expect(c.has(TOKENS.SecretScrubber)).toBe(true);
    expect(c.has(TOKENS.RetryPolicy)).toBe(true);
    expect(c.has(TOKENS.ErrorHandler)).toBe(true);
    expect(c.has(TOKENS.ModelsRegistry)).toBe(true);
    expect(c.has(TOKENS.TokenCounter)).toBe(true);
    expect(c.has(TOKENS.ModeStore)).toBe(true);
    expect(c.has(TOKENS.SessionStore)).toBe(true);
    expect(c.has(TOKENS.MemoryStore)).toBe(true);
    expect(c.has(TOKENS.SkillLoader)).toBe(true);
    expect(c.has(TOKENS.PermissionPolicy)).toBe(true);
    expect(c.has(TOKENS.Compactor)).toBe(true);
  });

  it('defaults SAGE storage to SQLite when the engine is omitted', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });

    expect(c.resolve(TOKENS.MemoryStore)).toBeInstanceOf(SqliteMemoryPort);
  });

  it('ignores the removed JSONL engine setting and still uses SQLite', () => {
    const c = createDefaultContainer({
      config: {
        ...mockConfig,
        Sage: { storage: { engine: 'jsonl' } },
      },
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });

    expect(c.resolve(TOKENS.MemoryStore)).toBeInstanceOf(SqliteMemoryPort);
  });

  it('resolves every default-bound token (exercises each factory)', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    // Touching each .resolve() runs the bound factory — this is how we get
    // function-level coverage on the factory bodies in container.ts.
    expect(c.resolve(TOKENS.Logger)).toBe(mockLogger);
    expect(c.resolve(TOKENS.FallbackProfileManager)).toBeDefined();
    expect(c.resolve(TOKENS.SecretScrubber)).toBeDefined();
    expect(c.resolve(TOKENS.RetryPolicy)).toBeDefined();
    expect(c.resolve(TOKENS.ErrorHandler)).toBeDefined();
    expect(c.resolve(TOKENS.ModelsRegistry)).toBe(mockModels);
    expect(c.resolve(TOKENS.TokenCounter)).toBeDefined();
    expect(c.resolve(TOKENS.ModeStore)).toBeDefined();
    expect(c.resolve(TOKENS.SessionStore)).toBeDefined();
    expect(c.resolve(TOKENS.MemoryStore)).toBeDefined();
    expect(c.resolve(TOKENS.MemoryPort)).toBeDefined();
    expect(c.resolve(TOKENS.SkillLoader)).toBeDefined();
    expect(c.resolve(TOKENS.PromptLoader)).toBeDefined();
    expect(c.resolve(TOKENS.PermissionPolicy)).toBeDefined();
    expect(c.resolve(TOKENS.Compactor)).toBeDefined();
  });

  it('binds SystemPromptBuilder when systemPrompt option is provided', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
      systemPrompt: { modeId: 'default', modePrompt: '', memoryStore: {} as any },
    });
    expect(c.has(TOKENS.SystemPromptBuilder)).toBe(true);
    expect(c.resolve(TOKENS.SystemPromptBuilder)).toBeDefined();
  });

  it('does not bind SystemPromptBuilder when systemPrompt option is not provided', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    expect(c.has(TOKENS.SystemPromptBuilder)).toBe(false);
  });

  it('binds Compactor with default options when compactor not provided', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    const compactor = c.resolve(TOKENS.Compactor);
    expect(compactor).toBeDefined();
  });

  it('passes custom compactor options', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
      compactor: { preserveK: 50, eliseThreshold: 0.5 },
    });
    const compactor = c.resolve(TOKENS.Compactor);
    expect(compactor).toBeDefined();
  });

  it('passes permission yolo option through the directory-policy wrapper', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
      permission: { yolo: true, promptDelegate: async () => 'yes' },
    });
    const policy = c.resolve(TOKENS.PermissionPolicy);
    expect(policy).toBeInstanceOf(DirectoryPermissionPolicy);
    expect(policy.getYolo?.()).toBe(true);
  });

  it('loads and enforces the in-project directory policy', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-directory-policy-'));
    fs.mkdirSync(path.join(projectRoot, '.wrongstack'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.wrongstack', 'directory-rules.json'),
      JSON.stringify({
        schemaVersion: 1,
        rules: [{ directory: 'secrets/**', denyTools: ['write'] }],
      }),
    );
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: {
        ...mockWpaths,
        projectRoot,
        projectSessions: path.join(projectRoot, 'sessions'),
        projectTrust: path.join(projectRoot, 'trust.json'),
      },
      logger: mockLogger,
      modelsRegistry: mockModels,
      permission: { yolo: true },
    });
    const policy = c.resolve(TOKENS.PermissionPolicy);

    await expect(
      policy.evaluate(
        { name: 'write', permission: 'auto' } as never,
        { path: 'secrets/token.txt' },
        { meta: {}, projectRoot, workingDir: projectRoot, provider: { id: 'anthropic' } } as never,
      ),
    ).resolves.toMatchObject({ permission: 'deny', source: 'directory_rules' });
  });

  it('rejects an invalid in-project directory policy instead of silently bypassing it', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wrongstack-directory-policy-invalid-'),
    );
    fs.mkdirSync(path.join(projectRoot, '.wrongstack'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.wrongstack', 'directory-rules.json'),
      JSON.stringify({
        schemaVersion: 1,
        rules: [{ directory: 'secrets/**', denyTool: ['write'] }],
      }),
    );
    expect(() =>
      createDefaultContainer({
        config: mockConfig,
        wpaths: {
          ...mockWpaths,
          projectRoot,
          projectSessions: path.join(projectRoot, 'sessions'),
          projectTrust: path.join(projectRoot, 'trust.json'),
        },
        logger: mockLogger,
        modelsRegistry: mockModels,
      }),
    ).toThrow('Invalid directory permission policy');
  });

  it('passes bundledSkillsDir to DefaultSkillLoader', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
      bundledSkillsDir: '/custom/skills',
    });
    const loader = c.resolve(TOKENS.SkillLoader);
    expect(loader).toBeDefined();
  });

  it('creates ModeStore with correct directory', () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    const modeStore = c.resolve(TOKENS.ModeStore);
    expect(modeStore).toBeInstanceOf(Object);
  });

  it('reports live registry sessions and safely handles registry failures', async () => {
    const c = createDefaultContainer({
      config: mockConfig,
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
    });
    const store = c.resolve(TOKENS.SessionStore) as SessionStore & {
      isSessionInUse: (sessionId: string) => Promise<string | null>;
    };
    const registry = getSessionRegistry(mockWpaths.globalRoot);
    const list = vi.spyOn(registry, 'listByProject');

    try {
      list.mockResolvedValueOnce([
        { sessionId: 'busy', projectName: 'WrongStack', pid: 4242 },
      ] as never);
      await expect(store.isSessionInUse('busy')).resolves.toBe('active in WrongStack (PID 4242)');

      list.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('registry unavailable'));
      await expect(store.isSessionInUse('free')).resolves.toBeNull();
      await expect(store.isSessionInUse('unknown')).resolves.toBeNull();
    } finally {
      list.mockRestore();
    }
  });

  it('uses live config while selecting an error-recovery downgrade', async () => {
    const modelsRegistry = {
      async getProvider() {
        return {
          models: [
            {
              id: 'cheap',
              cost: { input: 1 },
              tool_call: true,
              modalities: { input: ['text'] },
            },
          ],
        };
      },
      async getModel() {
        return {
          id: 'expensive',
          cost: { input: 10 },
          capabilities: { tools: false, vision: false },
        };
      },
    } as never;
    const c = createDefaultContainer({
      config: {
        ...mockConfig,
        providers: {
          anthropic: { type: 'anthropic', models: ['cheap', 'anthropic-test-model'] },
        },
      },
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry,
    });
    const handler = c.resolve(TOKENS.ErrorHandler);
    const decision = await handler.recover(
      new ProviderError('overloaded', 529, true, 'anthropic', { kind: 'overloaded' }),
      {
        provider: { id: 'anthropic' },
        model: 'anthropic-test-model',
      } as never,
    );
    expect(decision).toMatchObject({ action: 'retry', model: 'cheap' });
  });

  it('passes configured skill, prompt, memory, context, and event options', () => {
    const c = createDefaultContainer({
      config: {
        ...mockConfig,
        Sage: { storage: { directory: '.wrongstack/custom-sage' } },
        skills: {
          mode: 'eager',
          eagerMaxChars: 1234,
          readClaudeSkills: true,
          foreignSources: [],
          extraDirs: ['/tmp/extra-skills'],
        },
        context: {
          ...mockConfig.context,
          strategy: 'selective',
          summarizerModel: 'summary-model',
          llmSelector: { provider: 'anthropic', model: 'selector-model' },
        },
      },
      wpaths: mockWpaths,
      logger: mockLogger,
      modelsRegistry: mockModels,
      events: {} as never,
      bundledSkillsDir: '/tmp/bundled-skills',
      bundledPromptsDir: '/tmp/bundled-prompts',
      systemPrompt: { modeId: 'default', modePrompt: '' },
    });

    expect(c.resolve(TOKENS.MemoryPort)).toBeDefined();
    expect(c.resolve(TOKENS.TokenCounter)).toBeDefined();
    expect(c.resolve(TOKENS.SkillLoader)).toBeDefined();
    expect(c.resolve(TOKENS.PromptLoader)).toBeDefined();
    expect(c.resolve(TOKENS.SystemPromptBuilder)).toBeDefined();
    expect(c.resolve(TOKENS.Compactor)).toBeDefined();
  });
});
