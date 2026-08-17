import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretScrubber, DefaultSecretVault } from '@wrongstack/core/security';
import type { Config, ModelsRegistry } from '@wrongstack/core/types';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';
import { modelsCmd } from '../src/subcommands/handlers/providers-models.js';

// Low-entropy fixture token — never real credential material.
const TEST_API_TOKEN = 'fixture-token-models';

function makeRenderer() {
  const messages: string[] = [];
  const push = (value: unknown) => {
    messages.push(String(value));
  };
  return {
    renderer: {
      write: vi.fn(push),
      writeLine: vi.fn(push),
      writeBlock: vi.fn(push),
      writeToolCall: vi.fn(),
      writeToolResult: vi.fn(),
      writeDiff: vi.fn(),
      writeWarning: vi.fn(push),
      writeError: vi.fn(push),
      writeInfo: vi.fn(push),
      clear: vi.fn(),
      render: vi.fn(),
    } as never as TerminalRenderer,
    messages,
  };
}

function makeDeps(
  cfg: Config,
  configPath: string,
  renderer: TerminalRenderer,
  registryOverrides: Partial<ModelsRegistry> = {},
) {
  const modelsRegistry = {
    listProviders: vi.fn(async () => []),
    refresh: vi.fn(async () => ({ anthropic: {}, openai: {} })),
    suggestModel: vi.fn(async () => undefined),
    getProvider: vi.fn(async (id: string) => {
      if (id !== 'anthropic') return undefined;
      return {
        id: 'anthropic',
        name: 'Anthropic',
        family: 'anthropic',
        doc: 'https://docs.anthropic.com',
        models: [
          { id: 'claude-opus-4', name: 'Claude Opus 4', release_date: '2026-05-01' },
          { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', release_date: '2026-02-01' },
          { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', release_date: '2026-03-01' },
        ],
      };
    }),
    getModel: vi.fn(async (providerId: string, modelId: string) => {
      if (providerId !== 'anthropic' || modelId !== 'claude-opus-4') return undefined;
      return {
        id: modelId,
        name: 'Claude Opus 4',
        capabilities: {
          maxContext: 200_000,
          maxOutput: 32_000,
          knowledge: '2026-01',
          tools: true,
          vision: false,
          reasoning: true,
          reasoningConfig: {
            default: 'high',
            disableSupported: true,
            effortSupported: true,
            effortLevels: ['low', 'medium', 'high'],
            preserveThinking: false,
          },
        },
        cost: {
          input: 15,
          output: 75,
          cache_read: 1.5,
          cache_write: 18.75,
          cache_write_5m: 18.75,
        },
      };
    }),
    ageSeconds: vi.fn(async () => 0),
    ...registryOverrides,
  } as never as ModelsRegistry;

  return {
    config: cfg,
    renderer,
    reader: {} as never as ReadlineInputReader,
    sessionStore: undefined,
    skillLoader: undefined,
    toolRegistry: undefined,
    modelsRegistry,
    paths: {
      globalConfig: configPath,
      profileConfig: () => configPath,
      modelsCache: path.join(path.dirname(configPath), 'models.dev.json'),
    },
    vault: new DefaultSecretVault({ keyFile: path.join(path.dirname(configPath), '.key') }),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    userHome: os.homedir(),
    flags: {},
    scrubber: new DefaultSecretScrubber(),
  };
}

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-models-gaps-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude-opus-4',
    apiKey: TEST_API_TOKEN,
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

function output(messages: string[]): string {
  return stripAnsi(messages.join(''));
}

function readConfigFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
}

describe('wstack models refresh', () => {
  it('refreshes the catalog cache and reports the provider count', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['refresh'], deps as never);
    expect(code).toBe(0);
    expect(output(messages)).toContain('Cached 2 providers to');
    expect(output(messages)).toContain('models.dev.json');
  });

  it('reports refresh failures with exit code 1', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer, {
      refresh: vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    });
    const code = await modelsCmd(['refresh'], deps as never);
    expect(code).toBe(1);
    expect(output(messages)).toContain('Refresh failed: network unreachable');
  });
});

describe('wstack models <provider> listing', () => {
  it('prints the provider header with docs and paginates', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['anthropic', '--per-page', '2'], deps as never);
    expect(code).toBe(0);
    const text = output(messages);
    expect(text).toContain('Anthropic (anthropic)');
    expect(text).toContain('Docs: https://docs.anthropic.com');
    expect(text).toContain('[page 1/2]');
    // Newest release first.
    expect(text.indexOf('claude-opus-4')).toBeLessThan(text.indexOf('claude-sonnet-4'));

    const page2 = await modelsCmd(['anthropic', '--per-page', '2', '--page', '2'], deps as never);
    expect(page2).toBe(0);
    expect(output(messages)).toContain('[page 2/2]');
  });

  it('filters by search and reports no matches', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    await modelsCmd(['anthropic', '--search', 'haiku'], deps as never);
    const text = output(messages);
    expect(text).toContain('(filtered: "haiku" — 1 match)');
    expect(text).toContain('claude-haiku-4.5');
    expect(text).not.toContain('claude-opus-4');

    await modelsCmd(['anthropic', '--search', 'nothing-matches'], deps as never);
    expect(output(messages)).toContain('(no models match)');
  });

  it('rejects unknown providers', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['unknown-provider'], deps as never);
    expect(code).toBe(1);
    expect(output(messages)).toContain('Provider "unknown-provider" not in catalog.');
  });
});

describe('wstack models caps', () => {
  it('prints usage without provider/model defaults', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig({ provider: '', model: '' }), configPath, renderer);
    const code = await modelsCmd(['caps'], deps as never);
    expect(code).toBe(1);
    expect(output(messages)).toContain('Usage: wstack models caps [provider] [model]');
  });

  it('reports unknown models', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['caps', 'anthropic', 'not-a-model'], deps as never);
    expect(code).toBe(1);
    expect(output(messages)).toContain('Model not found in catalog: anthropic/not-a-model');
  });

  it('prints capabilities, pricing, and reasoning config', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['caps'], deps as never);
    expect(code).toBe(0);
    const text = output(messages);
    expect(text).toContain('context:      200000');
    expect(text).toContain('max output:   32000');
    expect(text).toContain('knowledge:    2026-01');
    expect(text).toContain('flags:        tools, reasoning');
    expect(text).toContain('pricing/1M:   input $15.0  output $75.0  cacheR $1.50');
    expect(text).toContain('cache write:  default $18.8  5m $18.8  1h $30.0');
    expect(text).toContain('default:    high');
    expect(text).toContain('effort:     low, medium, high');
    expect(text).toContain('preserve:   false');
  });
});

describe('wstack models add/remove/list', () => {
  it('prints add usage without a model id', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['add'], deps as never);
    expect(code).toBe(1);
    expect(output(messages)).toContain('Usage: wstack models add <modelId>');
  });

  it('adds a custom model with parsed flags and persists it', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(
      [
        'add',
        'my-model',
        '--provider',
        'openai',
        '--name',
        'My Model',
        '--max-context',
        '128k',
        '--max-output',
        '4k',
        '--tools',
        '--no-vision',
        '--reasoning',
      ],
      deps as never,
    );
    expect(code).toBe(0);
    const text = output(messages);
    expect(text).toContain('Custom model "my-model" added.');
    expect(text).toContain('tools: true');
    expect(text).toContain('vision: false');

    const models = readConfigFile()['models'] as Record<string, Record<string, unknown>>;
    expect(models['my-model']).toMatchObject({
      provider: 'openai',
      name: 'My Model',
      maxOutput: 4000,
      capabilities: {
        tools: true,
        vision: false,
        reasoning: true,
        maxContext: 128_000,
      },
    });
  });

  it('warns when overwriting an existing custom model', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(
      baseConfig({ models: { 'my-model': { name: 'Old' } } }),
      configPath,
      renderer,
    );
    const code = await modelsCmd(['add', 'my-model', '--tools'], deps as never);
    expect(code).toBe(0);
    expect(output(messages)).toContain('already defined. Overwriting.');
    expect(output(messages)).toContain('Custom model "my-model" updated.');
  });

  it('lists custom models with their capabilities', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(
      baseConfig({
        models: {
          'zz-model': { name: 'ZZ', provider: 'openai', maxOutput: 1000 },
          'aa-model': { capabilities: { tools: true } },
        },
      }),
      configPath,
      renderer,
    );
    const code = await modelsCmd(['list'], deps as never);
    expect(code).toBe(0);
    const text = output(messages);
    expect(text.indexOf('aa-model')).toBeLessThan(text.indexOf('ZZ'));
    expect(text).toContain('(openai)');
    expect(text).toContain('maxOutput: 1000');
    expect(text).toContain('tools: true');
  });

  it('reports an empty custom model list', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);
    const code = await modelsCmd(['list'], deps as never);
    expect(code).toBe(0);
    expect(output(messages)).toContain('No custom models defined.');
  });

  it('removes custom models and reports unknown ids', async () => {
    const { renderer, messages } = makeRenderer();
    const deps = makeDeps(baseConfig(), configPath, renderer);

    const usage = await modelsCmd(['remove'], deps as never);
    expect(usage).toBe(1);
    expect(output(messages)).toContain('Usage: wstack models remove <modelId>');

    const missing = await modelsCmd(['remove', 'ghost'], deps as never);
    expect(missing).toBe(1);
    expect(output(messages)).toContain('No custom model "ghost" found.');

    // remove() consults the in-memory config AND the on-disk section, so seed
    // both before removing.
    (deps.config as unknown as { models?: Record<string, unknown> }).models = { doomed: {} };
    fs.writeFileSync(configPath, JSON.stringify({ models: { doomed: {} } }, null, 2));
    const removed = await modelsCmd(['remove', 'doomed'], deps as never);
    expect(removed).toBe(0);
    expect(output(messages)).toContain('Removed custom model "doomed".');
    expect(readConfigFile()['models']).toEqual({});
  });
});
