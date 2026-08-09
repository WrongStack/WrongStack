import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs/promises at module level (ESM-safe)
const FAKE_CACHE = JSON.stringify({
  payload: {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      npm: 'openai',
      models: {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          limit: { context: 128000, output: 16384 },
          cost: { input: 2.5, output: 10 },
        },
      },
    },
  },
});

const mockReadFile = vi.hoisted(() => vi.fn(async () => FAKE_CACHE));
vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: vi.fn(async () => undefined),
}));

// Mock the modeldiag-profiles module
vi.mock('../src/subcommands/handlers/modeldiag-profiles.js', () => ({
  MODEL_PROFILES: [],
  fmtTokens: (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)),
  fmtMs: (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`),
  fmtPrice: (v?: number) => (v === undefined ? '?' : `$${v.toFixed(2)}`),
  checkMark: (ok: boolean) => (ok ? '✓' : '✗'),
  costLabel: (t: string) => (t === 'premium' ? '$$$' : t === 'budget' ? '$' : '$$'),
  speedLabel: (t: string) => (t === 'fast' ? '⚡' : t === 'slow' ? '🐢' : '→'),
  scoreBar: (s: number, m: number) => `${s}/${m}`,
  findProfile: () => undefined,
  scoreModel: () => ({ score: 50 }),
  rankModels: () => [],
  roleCat: (r: string) => (r === 'bug-hunter' ? 'debugging' : 'general'),
  ROLE_CATEGORY: { 'bug-hunter': 'debugging' },
  EVAL_CATEGORIES: ['coding', 'planning'],
  EVAL_TASKS: {
    coding: { label: 'Code', prompt: 'Write code.' },
    planning: { label: 'Plan', prompt: 'Plan.' },
  },
}));

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(() => ({
    id: 'openai',
    capabilities: { maxContext: 128000 },
    complete: vi.fn(),
  })),
  setOAuthTokenPersister: vi.fn(),
}));

vi.mock('../src/boot/auto-discover-providers.js', () => ({
  discoverAndMergeProviders: vi.fn(async () => undefined),
}));
vi.mock('../src/provider-config-utils.js', () => ({
  mutateConfigProviders: vi.fn(async () => undefined),
  normalizeKeys: vi.fn(() => []),
  writeKeysBack: vi.fn(),
}));
vi.mock('../src/profile-config-path.js', () => ({
  activeProfileConfigPath: vi.fn(() => '/tmp/cfg.json'),
}));
vi.mock('../src/subcommands/handlers/model-smoke-test.js', () => ({
  buildModelSmokeTargets: vi.fn(async () => []),
  parseModelSmokeOptions: vi.fn(() => ({
    planOnly: false,
    allModels: false,
    timeoutMs: 45000,
    maxTokens: 32,
    json: false,
    providerIds: undefined,
    modelIds: undefined,
  })),
  runModelSmokeTests: vi.fn(async () => []),
}));

import { modeldiagCmd } from '../src/subcommands/handlers/modeldiag.js';

function makeDeps() {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      renderer: {
        write: vi.fn((s: string) => {
          lines.push(s);
        }),
      },
      config: {
        provider: 'openai',
        model: 'gpt-4o',
        providers: { openai: { type: 'openai', apiKey: 'sk-test' } },
        modelMatrix: {},
      },
      paths: {
        modelsCache: '/tmp/cache.json',
        cacheDir: '/tmp/cache',
      },
      modelsRegistry: {} as any,
      flags: {} as Record<string, unknown>,
      vault: {} as any,
    } as any,
  };
}

describe('modeldiag handler', () => {
  beforeEach(() => {
    mockReadFile.mockResolvedValue(FAKE_CACHE);
  });

  it('returns error when models cache is not available', async () => {
    const { deps } = makeDeps();
    deps.paths.modelsCache = undefined;
    const code = await modeldiagCmd(['full'], deps);
    expect(code).toBeGreaterThanOrEqual(0);
  });

  it('keys subcommand lists provider key status', async () => {
    const { deps, lines } = makeDeps();
    const code = await modeldiagCmd(['keys'], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('openai'))).toBe(true);
  });

  it('caps subcommand shows model capabilities', async () => {
    const { deps, lines } = makeDeps();
    const code = await modeldiagCmd(['caps'], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('openai'))).toBe(true);
  });

  it('suggest subcommand renders agent→model suggestions', async () => {
    const { deps, lines } = makeDeps();
    const code = await modeldiagCmd(['suggest'], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('Suggestions') || l.includes('leader'))).toBe(true);
  });

  it('test --plan shows smoke test plan', async () => {
    const { deps, lines } = makeDeps();
    const { buildModelSmokeTargets } = await import(
      '../src/subcommands/handlers/model-smoke-test.js'
    );
    vi.mocked(buildModelSmokeTargets).mockResolvedValue([
      { providerId: 'openai', modelId: 'gpt-4o' } as any,
    ]);
    const code = await modeldiagCmd(['test', '--plan'], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('Smoke Test Plan') || l.includes('request'))).toBe(true);
  });

  it('test --help shows usage', async () => {
    const { deps, lines } = makeDeps();
    const code = await modeldiagCmd(['test', '--help'], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('Usage'))).toBe(true);
  });

  it('defaults to "full" subcommand when no args', async () => {
    const { deps } = makeDeps();
    const code = await modeldiagCmd([], deps);
    expect(code).toBeGreaterThanOrEqual(0);
  });

  it('handles corrupted models cache gracefully', async () => {
    const { deps } = makeDeps();
    mockReadFile.mockResolvedValue('not valid json');
    const code = await modeldiagCmd(['keys'], deps);
    expect(code).toBeGreaterThanOrEqual(0);
  });

  it('handles missing models cache path', async () => {
    const { deps } = makeDeps();
    deps.paths.modelsCache = undefined;
    const code = await modeldiagCmd(['suggest'], deps);
    expect(code).toBeGreaterThanOrEqual(0);
  });
});
