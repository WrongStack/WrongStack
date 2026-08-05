/**
 * Coverage for add-provider.ts's `addFromCatalog` entry points — the
 * interactive catalog picker path, the manual-entry fallbacks, and the
 * OAuth-after-cancel offer. The TTY picker itself (`runLiveProviderPicker`
 * from src/picker.ts) is mocked; everything downstream runs for real
 * against a temp-dir config + DefaultSecretVault.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthMenuDeps } from '../src/auth-menu/types.js';
import { addFromCatalog } from '../src/auth-menu/add-provider.js';

const pickerMock = vi.hoisted(() => ({
  runLiveProviderPicker: vi.fn(),
}));

vi.mock('../src/picker.js', async (orig) => ({
  ...(await orig<typeof import('../src/picker.js')>()),
  runLiveProviderPicker: pickerMock.runLiveProviderPicker,
}));

// The OAuth offer after a cancelled pick routes into the real login modules;
// stub them so the addFromCatalog branch is covered hermetically.
const oauthMocks = vi.hoisted(() => ({
  runCodexOAuthLogin: vi.fn(async () => 0),
  runClaudeOAuthLogin: vi.fn(async () => 0),
  runCopilotOAuthLogin: vi.fn(async () => 0),
}));

vi.mock('../src/auth-menu/openai-codex-oauth.js', async (orig) => ({
  ...(await orig<typeof import('../src/auth-menu/openai-codex-oauth.js')>()),
  runCodexOAuthLogin: oauthMocks.runCodexOAuthLogin,
}));
vi.mock('../src/auth-menu/anthropic-oauth.js', async (orig) => ({
  ...(await orig<typeof import('../src/auth-menu/anthropic-oauth.js')>()),
  runClaudeOAuthLogin: oauthMocks.runClaudeOAuthLogin,
}));
vi.mock('../src/auth-menu/github-copilot-oauth.js', async (orig) => ({
  ...(await orig<typeof import('../src/auth-menu/github-copilot-oauth.js')>()),
  runCopilotOAuthLogin: oauthMocks.runCopilotOAuthLogin,
}));

const CATALOG_ROW: ResolvedProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  family: 'anthropic',
  apiBase: 'https://api.anthropic.com',
  envVars: ['ANTHROPIC_API_KEY'],
} as never as ResolvedProvider;

async function setup(opts: {
  listProviders?: () => Promise<ResolvedProvider[]>;
  preExisting?: object;
} = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-auth-catalog-'));
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const registry = {
    getProvider: vi.fn(async () => undefined),
    listProviders: vi.fn(opts.listProviders ?? (async () => [])),
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
  const logs: string[] = [];
  let i = 0;
  const next = async () => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return (await a) ?? '';
  };
  const answers: Array<string | Error | Promise<string>> = [];
  const deps: AuthMenuDeps = {
    renderer: {
      write: (s: string) => logs.push(s),
      writeInfo: (s: string) => logs.push(s),
      writeWarning: (s: string) => logs.push(s),
      writeError: (s: string) => logs.push(s),
    },
    reader: {
      readLine: async () => next(),
      readSecret: async () => next(),
    },
    modelsRegistry: registry,
    vault,
    profileConfigPath: configPath,
  };
  return { deps, logs, configPath, answers, registry };
}

async function readProviders(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    return {};
  }
  return ((JSON.parse(raw) as Record<string, unknown>).providers as Record<string, unknown>) ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  pickerMock.runLiveProviderPicker.mockReset();
});

describe('addFromCatalog — manual entry fallbacks', () => {
  it('falls back to manual entry when the catalog is unavailable', async () => {
    const { deps, logs, answers, configPath } = await setup({
      listProviders: async () => {
        throw new Error('registry down');
      },
    });
    answers.push('my-manual', 'openai', 'http://manual.local/v1', 'default', 'sk-m-1234567890');
    expect(await addFromCatalog(deps)).toBe(true);
    expect(logs.some((l) => l.includes('Catalog unavailable'))).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['my-manual']).toMatchObject({
      type: 'my-manual',
      family: 'openai',
      baseUrl: 'http://manual.local/v1',
      activeKey: 'default',
    });
  });

  it('falls back to manual entry when the catalog is empty', async () => {
    const { deps, answers, configPath } = await setup({ listProviders: async () => [] });
    answers.push('my-empty', 'openai', '', 'default', 'sk-e-1234567890');
    expect(await addFromCatalog(deps)).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['my-empty']).toMatchObject({ type: 'my-empty', family: 'openai' });
  });

  it('aborts manual entry on a blank or q provider id', async () => {
    const blank = await setup({ listProviders: async () => [] });
    blank.answers.push('');
    expect(await addFromCatalog(blank.deps)).toBe(false);

    const quit = await setup({ listProviders: async () => [] });
    quit.answers.push('q');
    expect(await addFromCatalog(quit.deps)).toBe(false);
  });

  it('rejects an invalid family in manual entry', async () => {
    const { deps, logs, answers } = await setup({ listProviders: async () => [] });
    answers.push('x', 'mystery');
    expect(await addFromCatalog(deps)).toBe(false);
    expect(logs.some((l) => l.includes('Invalid family: "mystery"'))).toBe(true);
  });
});

describe('addFromCatalog — interactive picker path', () => {
  it('adds the picked catalog provider with defaults', async () => {
    const { deps, logs, answers, configPath } = await setup({
      listProviders: async () => [CATALOG_ROW],
    });
    pickerMock.runLiveProviderPicker.mockResolvedValue(CATALOG_ROW);
    answers.push('', '', '', 'default', 'sk-c-1234567890');
    expect(await addFromCatalog(deps)).toBe(true);
    expect(pickerMock.runLiveProviderPicker).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('Catalog: 1 providers'))).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['anthropic']).toMatchObject({
      type: 'anthropic',
      family: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      envVars: ['ANTHROPIC_API_KEY'],
    });
  });

  it('filters unsupported families out of the catalog', async () => {
    const { deps, answers } = await setup({
      listProviders: async () => [CATALOG_ROW, { ...CATALOG_ROW, id: 'legacy', family: 'unsupported' } as never],
    });
    pickerMock.runLiveProviderPicker.mockResolvedValue(CATALOG_ROW);
    answers.push('', '', '', 'default', 'sk-c-1234567890');
    expect(await addFromCatalog(deps)).toBe(true);
    expect(pickerMock.runLiveProviderPicker.mock.calls[0]![0]).toHaveLength(1);
  });

  it('offers OAuth after a cancelled pick and quits on q', async () => {
    const { deps, logs, answers } = await setup({
      listProviders: async () => [CATALOG_ROW],
    });
    pickerMock.runLiveProviderPicker.mockResolvedValue(null);
    answers.push('q');
    expect(await addFromCatalog(deps)).toBe(false);
    expect(logs.some((l) => l.includes('OAuth login options:'))).toBe(true);
  });

  it.each(['chatgpt', 'claude', 'copilot'] as const)(
    'completes via the OAuth offer for %s',
    async (kind) => {
      const { deps, answers } = await setup({ listProviders: async () => [CATALOG_ROW] });
      pickerMock.runLiveProviderPicker.mockResolvedValue(null);
      answers.push(kind);
      expect(await addFromCatalog(deps)).toBe(true);
      const calls: Record<string, unknown> = {
        chatgpt: oauthMocks.runCodexOAuthLogin,
        claude: oauthMocks.runClaudeOAuthLogin,
        copilot: oauthMocks.runCopilotOAuthLogin,
      };
      expect(calls[kind]).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an unknown OAuth answer after a cancelled pick', async () => {
    const { deps, answers } = await setup({ listProviders: async () => [CATALOG_ROW] });
    pickerMock.runLiveProviderPicker.mockResolvedValue(null);
    answers.push('bogus');
    expect(await addFromCatalog(deps)).toBe(false);
    expect(oauthMocks.runCodexOAuthLogin).not.toHaveBeenCalled();
  });

  it('treats an empty OAuth answer as cancel', async () => {
    const { deps, answers } = await setup({ listProviders: async () => [CATALOG_ROW] });
    pickerMock.runLiveProviderPicker.mockResolvedValue(null);
    answers.push('');
    expect(await addFromCatalog(deps)).toBe(false);
  });
});
