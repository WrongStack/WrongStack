// Tests for the TUI auth-panel host (packages/cli/src/auth-menu/panel-service.ts):
// structured provider listing (masked keys), direct mutations, and the
// AuthFlowIo bridge that drives the existing readline flows from the TUI —
// including the Esc-cancel contract (a rejected prompt aborts the flow
// before anything is saved).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import type { AuthFlowIo } from '@wrongstack/tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flowMocks = vi.hoisted(() => ({
  runCodexOAuthLogin: vi.fn(async () => 0),
  runClaudeOAuthLogin: vi.fn(async () => 1),
  runCopilotOAuthLogin: vi.fn(async () => 0),
  runAuthLocal: vi.fn(async () => 0),
}));

vi.mock('../src/auth-menu/openai-codex-oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth-menu/openai-codex-oauth.js')>()),
  runCodexOAuthLogin: flowMocks.runCodexOAuthLogin,
}));
vi.mock('../src/auth-menu/anthropic-oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth-menu/anthropic-oauth.js')>()),
  runClaudeOAuthLogin: flowMocks.runClaudeOAuthLogin,
}));
vi.mock('../src/auth-menu/github-copilot-oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth-menu/github-copilot-oauth.js')>()),
  runCopilotOAuthLogin: flowMocks.runCopilotOAuthLogin,
}));
vi.mock('../src/auth-menu/local.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth-menu/local.js')>()),
  runAuthLocal: flowMocks.runAuthLocal,
}));

const { createAuthPanelHost, plainMaskedKey } = await import('../src/auth-menu/panel-service.js');

async function mkTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wstack-auth-panel-'));
}

function makeModelsRegistry(catalog: Partial<ResolvedProvider>[]): ModelsRegistry {
  return {
    getProvider: vi.fn(async (id: string) => catalog.find((p) => p.id === id)),
    listProviders: vi.fn(async () => catalog as ResolvedProvider[]),
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
}

async function setup(opts: { catalog?: Partial<ResolvedProvider>[]; preExisting?: object } = {}) {
  const tmpDir = await mkTempDir();
  const rootConfigPath = path.join(tmpDir, 'config.json');
  const configPath = path.join(tmpDir, 'profiles', 'default', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    rootConfigPath,
    JSON.stringify({ version: 1, activeProfile: 'default' }),
    { mode: 0o600 },
  );
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const host = createAuthPanelHost({
    vault,
    modelsRegistry: makeModelsRegistry(opts.catalog ?? []),
    profileConfigPath: configPath,
  });
  return { host, configPath, rootConfigPath };
}

/** Scripted AuthFlowIo: each prompt consumes the next answer (Error → reject). */
function makeIo(answers: Array<string | Error> = []) {
  const log: string[] = [];
  const prompts: Array<{ question: string; secret: boolean }> = [];
  let i = 0;
  const io: AuthFlowIo = {
    onLog: (line) => log.push(line),
    prompt: async (question, { secret }) => {
      prompts.push({ question, secret });
      const answer = answers[i++];
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    signal: new AbortController().signal,
  };
  return { io, log, prompts };
}

function cancelError(): Error {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

const TWO_KEYS_CONFIG = {
  providers: {
    anthropic: {
      type: 'anthropic',
      family: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKeys: [
        { label: 'work', apiKey: 'sk-work-1234567890', createdAt: '2026-01-01T00:00:00.000Z' },
        { label: 'personal', apiKey: 'sk-personal-123456', createdAt: '2026-02-01T00:00:00.000Z' },
      ],
      activeKey: 'personal',
    },
    zebra: { type: 'zebra', apiKeys: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plainMaskedKey', () => {
  it('masks to head…tail without ANSI codes', () => {
    expect(plainMaskedKey('sk-abcdefghij1234')).toBe('sk-a…1234');
    expect(plainMaskedKey('short')).toBe('•••••');
    expect(plainMaskedKey('')).toBe('—');
  });
});

describe('listProviders', () => {
  it('returns sorted rows with masked keys and the active flag', async () => {
    const { host } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const rows = await host.listProviders();
    expect(rows.map((r) => r.id)).toEqual(['anthropic', 'zebra']);
    const anthropic = rows[0]!;
    expect(anthropic.family).toBe('anthropic');
    expect(anthropic.keys).toHaveLength(2);
    expect(anthropic.keys[0]).toMatchObject({ label: 'work', active: false });
    expect(anthropic.keys[1]).toMatchObject({ label: 'personal', active: true });
    // Never the plaintext key.
    expect(JSON.stringify(rows)).not.toContain('sk-work-1234567890');
    expect(anthropic.keys[0]?.masked).toBe('sk-w…7890');
  });

  it('returns [] for a missing config file', async () => {
    const { host } = await setup();
    expect(await host.listProviders()).toEqual([]);
  });
});

describe('listCatalog', () => {
  it('filters unsupported families and flags saved providers', async () => {
    const { host } = await setup({
      preExisting: TWO_KEYS_CONFIG,
      catalog: [
        { id: 'openai', name: 'OpenAI', family: 'openai', envVars: [] },
        { id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: [] },
        { id: 'legacy', name: 'Legacy', family: 'unsupported' as never, envVars: [] },
      ],
    });
    const catalog = await host.listCatalog();
    expect(catalog.map((c) => c.id)).toEqual(['anthropic', 'openai']);
    expect(catalog[0]?.saved).toBe(true);
    expect(catalog[1]?.saved).toBe(false);
  });
});

describe('direct mutations', () => {
  it('setActiveKey flips the active label', async () => {
    const { host, configPath, rootConfigPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    expect(await host.setActiveKey('anthropic', 'work')).toBeNull();
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic.activeKey).toBe('work');
    expect(JSON.parse(await fs.readFile(rootConfigPath, 'utf8'))).toEqual({
      version: 1,
      activeProfile: 'default',
    });
  });

  it('deleteKey removes the entry and repoints the active label', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    expect(await host.deleteKey('anthropic', 'personal')).toBeNull();
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic.apiKeys).toHaveLength(1);
    expect(raw.providers.anthropic.activeKey).toBe('work');
  });

  it('removeProvider deletes the whole entry', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    expect(await host.removeProvider('zebra')).toBeNull();
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.zebra).toBeUndefined();
    expect(raw.providers.anthropic).toBeDefined();
  });

  it('removeProvider clears stale default provider/model', async () => {
    const { host, configPath } = await setup({
      preExisting: { ...TWO_KEYS_CONFIG, provider: 'anthropic', model: 'claude-old' },
    });
    expect(await host.removeProvider('anthropic')).toBeNull();
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic).toBeUndefined();
    expect(raw.provider).toBeUndefined();
    expect(raw.model).toBeUndefined();
  });

  it('deleteKey clears stale default provider/model when the last key is removed', async () => {
    const { host, configPath } = await setup({
      preExisting: {
        provider: 'anthropic',
        model: 'claude-old',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKeys: [{ label: 'only', apiKey: 'sk-only', createdAt: '2026-01-01' }],
            activeKey: 'only',
          },
        },
      },
    });
    expect(await host.deleteKey('anthropic', 'only')).toBeNull();
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.provider).toBeUndefined();
    expect(raw.model).toBeUndefined();
  });

  it('surfaces errors as strings instead of throwing', async () => {
    const { host } = await setup({ preExisting: TWO_KEYS_CONFIG });
    expect(await host.setActiveKey('nope', 'x')).toMatch(/no longer in config/);
    expect(await host.deleteKey('anthropic', 'ghost')).toMatch(/not found/);
    expect(await host.removeProvider('nope')).toMatch(/no longer in config/);
  });
});

describe('addKey flow (prompt bridge)', () => {
  it('prompts label then key (masked) and saves encrypted', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const { io, prompts } = makeIo(['backup', 'sk-new-abcdef123456']);
    const result = await host.addKey('anthropic', io);
    expect(result.ok).toBe(true);
    expect(prompts[0]?.secret).toBe(false); // label
    expect(prompts[1]?.secret).toBe(true); // key
    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain('sk-new-abcdef123456');
    expect(JSON.parse(raw).providers.anthropic.apiKeys).toHaveLength(3);
  });

  it('Esc-cancel (rejected prompt) leaves the config untouched', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const before = await fs.readFile(configPath, 'utf8');
    const { io } = makeIo([cancelError()]);
    const result = await host.addKey('anthropic', io);
    expect(result).toEqual({ ok: false, message: 'Cancelled.' });
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });
});

describe('updateKey flow', () => {
  it('replaces the key material for the given label', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const { io, log, prompts } = makeIo(['sk-rotated-9876543210']);
    const result = await host.updateKey('anthropic', 'work', io);
    expect(result.ok).toBe(true);
    expect(prompts[0]?.secret).toBe(true);
    expect(log.some((l) => l.includes('Updated anthropic/work'))).toBe(true);
    const raw = await fs.readFile(configPath, 'utf8');
    expect(raw).not.toContain('sk-rotated-9876543210'); // encrypted at rest
  });

  it('rejects an empty key without mutating', async () => {
    const { host } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const { io, log } = makeIo(['   ']);
    const result = await host.updateKey('anthropic', 'work', io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('No key entered'))).toBe(true);
  });
});

describe('editField flow', () => {
  it('validates the wire family', async () => {
    const { host } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const { io, log } = makeIo(['not-a-family']);
    const result = await host.editField('anthropic', 'family', io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('Invalid family'))).toBe(true);
  });

  it('sets and unsets baseUrl', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    expect(
      (await host.editField('anthropic', 'baseUrl', makeIo(['https://proxy.local/v1']).io)).ok,
    ).toBe(true);
    let raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic.baseUrl).toBe('https://proxy.local/v1');
    expect((await host.editField('anthropic', 'baseUrl', makeIo(['']).io)).ok).toBe(true);
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic.baseUrl).toBeUndefined();
  });

  it('parses the comma-separated model list', async () => {
    const { host, configPath } = await setup({ preExisting: TWO_KEYS_CONFIG });
    const result = await host.editField('anthropic', 'models', makeIo(['a, b , ,c']).io);
    expect(result.ok).toBe(true);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic.models).toEqual(['a', 'b', 'c']);
  });
});

describe('flow delegation', () => {
  it('oauthLogin routes kinds to the right flow and forwards the abort signal', async () => {
    const { host } = await setup();
    const { io } = makeIo();
    expect((await host.oauthLogin('chatgpt', io)).ok).toBe(true);
    expect(flowMocks.runCodexOAuthLogin).toHaveBeenCalledTimes(1);
    const [, opts] = flowMocks.runCodexOAuthLogin.mock.calls[0] as unknown as [
      unknown,
      { signal?: AbortSignal },
    ];
    expect(opts.signal).toBe(io.signal);

    expect((await host.oauthLogin('claude', io)).ok).toBe(false); // mock exit code 1
    expect((await host.oauthLogin('copilot', io)).ok).toBe(true);
  });

  it('addLocal prompts for the base URL and forwards preset + models capture', async () => {
    const { host } = await setup();
    const { io } = makeIo(['http://localhost:9999/v1']);
    expect((await host.addLocal('ollama', io)).ok).toBe(true);
    const [, opts] = flowMocks.runAuthLocal.mock.calls[0] as unknown as [
      unknown,
      { name?: string; baseUrl?: string; models?: string },
    ];
    expect(opts).toMatchObject({
      name: 'ollama',
      baseUrl: 'http://localhost:9999/v1',
      models: '999',
    });
  });

  it('addLocal empty answer falls back to the preset default URL', async () => {
    const { host } = await setup();
    const { io } = makeIo(['']);
    expect((await host.addLocal('ollama', io)).ok).toBe(true);
    const [, opts] = flowMocks.runAuthLocal.mock.calls[0] as unknown as [
      unknown,
      { baseUrl?: string },
    ];
    expect(opts.baseUrl).toBeUndefined();
  });

  it('addLocal rejects an unknown preset id', async () => {
    const { host } = await setup();
    const { io, log } = makeIo();
    expect((await host.addLocal('nope', io)).ok).toBe(false);
    expect(log.some((l) => l.includes('Unknown local preset'))).toBe(true);
  });

  it('addCatalogProvider rejects an unknown catalog id', async () => {
    const { host } = await setup({ catalog: [] });
    const { io, log } = makeIo();
    expect((await host.addCatalogProvider('ghost', io)).ok).toBe(false);
    expect(log.some((l) => l.includes('not found'))).toBe(true);
  });
});
