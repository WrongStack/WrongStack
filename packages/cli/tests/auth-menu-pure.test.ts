/**
 * Focused coverage for the auth-menu submodules' pure-logic surface:
 * shared.ts (render helpers + input/validation helpers), oauth-menu.ts
 * (kind resolution + renders), and panel-service.ts (key masking).
 *
 * The interactive flows (runTopMenu / manageProvider / runAuthLocal /
 * addFromCatalog) need a full provider store and are out of scope here —
 * they're covered by the existing auth-menu integration tests.
 */

import type { ProviderConfig } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderOAuthLoginOptions, resolveOAuthKind } from '../src/auth-menu/oauth-menu.js';
import { plainMaskedKey } from '../src/auth-menu/panel-service.js';
import {
  confirm,
  readKeyInput,
  renderActions,
  renderProviderHeader,
  renderTopMenu,
  suggestLabel,
  validateFamily,
} from '../src/auth-menu/shared.js';

function renderer() {
  return {
    write: vi.fn(),
    writeInfo: vi.fn(),
    writeError: vi.fn(),
    writeWarning: vi.fn(),
  };
}

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'openai', ...over } as ProviderConfig;
}

describe('shared.ts — render helpers', () => {
  it('renderTopMenu shows the empty state and the manage hint with providers', () => {
    const r = renderer();
    renderTopMenu(r, {});
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('No providers configured yet'));
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('(a) to add one'));

    const r2 = renderer();
    renderTopMenu(r2, { openai: cfg({ family: 'openai' }) });
    expect(r2.write).toHaveBeenCalledWith(expect.stringContaining('Saved providers:'));
    expect(r2.write).toHaveBeenCalledWith(expect.stringContaining('1-1  Manage a provider'));

    // Multi-key provider → the "N keys · active: …" summary line.
    const r3 = renderer();
    renderTopMenu(r3, {
      openai: cfg({
        family: 'openai',
        apiKeys: [
          { label: 'work', apiKey: 'sk-aaaa1111bbbb2222', createdAt: '2020-01-01T00:00:00.000Z' },
          { label: 'home', apiKey: 'sk-cccc3333dddd4444', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
      }),
    });
    expect(r3.write).toHaveBeenCalledWith(expect.stringContaining('2 keys'));
    expect(r3.write).toHaveBeenCalledWith(expect.stringContaining('active:'));
  });

  it('renderProviderHeader renders family, type, baseUrl, and keys', () => {
    const r = renderer();
    renderProviderHeader(
      r,
      'openai',
      cfg({ family: 'openai', baseUrl: 'https://x', apiKey: 'sk-1234567890abcdef' }),
    );
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('[openai]'));
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('https://x'));

    const rNoFamily = renderer();
    renderProviderHeader(rNoFamily, 'custom', cfg({}));
    expect(rNoFamily.write).toHaveBeenCalledWith(expect.stringContaining('[no family]'));
  });

  it('renderProviderHeader handles a provider with multiple keys and no baseUrl', () => {
    const r = renderer();
    renderProviderHeader(
      r,
      'multi',
      cfg({
        family: 'openai',
        apiKeys: [
          { label: 'work', apiKey: 'sk-aaaa1111bbbb2222', createdAt: '2020-01-01T00:00:00.000Z' },
          { label: 'home', apiKey: 'sk-cccc3333dddd4444', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('multi'));

    const rNoUrl = renderer();
    renderProviderHeader(rNoUrl, 'nourl', cfg({ family: 'openai' }));
    expect(rNoUrl.write).toHaveBeenCalledWith(expect.stringContaining('unset → catalog default'));
  });

  it('renderActions includes key actions only when keys exist', () => {
    const r0 = renderer();
    renderActions(r0, 0);
    const calls0 = r0.write.mock.calls.flat().join('');
    expect(calls0).not.toContain('Set key');

    const r1 = renderer();
    renderActions(r1, 2);
    const calls1 = r1.write.mock.calls.flat().join('');
    expect(calls1).toContain('Update key');
    expect(calls1).toContain('Delete key');
    expect(calls1).toContain('Set key');
  });
});

describe('shared.ts — input/validation helpers', () => {
  it('readKeyInput trims and rejects empty input', async () => {
    const deps = {
      reader: { readSecret: vi.fn(async () => '  sk-abc  ') },
      renderer: renderer(),
    } as never;
    await expect(readKeyInput(deps, 'Add key')).resolves.toBe('sk-abc');

    const empty = {
      reader: { readSecret: vi.fn(async () => '   ') },
      renderer: renderer(),
    } as never;
    await expect(readKeyInput(empty, 'Add key')).resolves.toBeUndefined();
  });

  it('confirm maps y/n/q answers', async () => {
    const mk = (answer: string) =>
      ({ reader: { readLine: vi.fn(async () => answer) }, renderer: renderer() }) as never;
    await expect(confirm(mk('y'), 'Proceed?')).resolves.toBe(true);
    await expect(confirm(mk('yes'), 'Proceed?')).resolves.toBe(true);
    await expect(confirm(mk('n'), 'Proceed?')).resolves.toBe(false);
    await expect(confirm(mk('no'), 'Proceed?')).resolves.toBe(false);
    await expect(confirm(mk('q'), 'Proceed?')).resolves.toBeNull();
    await expect(confirm(mk('quit'), 'Proceed?')).resolves.toBeNull();
  });

  it('suggestLabel returns default then key2, key3, …', () => {
    expect(suggestLabel(new Set())).toBe('default');
    expect(suggestLabel(new Set(['default']))).toBe('key2');
    expect(suggestLabel(new Set(['default', 'key2']))).toBe('key3');
  });

  it('validateFamily accepts known families and rejects others', () => {
    expect(validateFamily('anthropic')).toBe('anthropic');
    expect(validateFamily('openai')).toBe('openai');
    expect(validateFamily('openai-compatible')).toBe('openai-compatible');
    expect(validateFamily('google')).toBe('google');
    expect(validateFamily('mystery')).toBeNull();
  });
});

describe('oauth-menu.ts', () => {
  it('resolves OAuth kinds by alias and numeric pick', () => {
    expect(resolveOAuthKind('chatgpt')).toBe('chatgpt');
    expect(resolveOAuthKind('OpenAI-Codex')).toBe('chatgpt');
    expect(resolveOAuthKind('plus')).toBe('chatgpt');
    expect(resolveOAuthKind('claude-max')).toBe('claude');
    expect(resolveOAuthKind('gh')).toBe('copilot');
    expect(resolveOAuthKind('2')).toBe('claude'); // numeric allowed by default
    expect(resolveOAuthKind('  ')).toBeUndefined();
    expect(resolveOAuthKind('unknown')).toBeUndefined();
  });

  it('disables numeric picks when allowNumeric is false', () => {
    expect(resolveOAuthKind('3', { allowNumeric: false })).toBeUndefined();
    expect(resolveOAuthKind('copilot', { allowNumeric: false })).toBe('copilot');
  });

  it('renders the OAuth login options block', () => {
    const r = renderer();
    renderOAuthLoginOptions({ renderer: r } as never);
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('OAuth login options'));
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('chatgpt'));
    expect(r.write).toHaveBeenCalledWith(expect.stringContaining('copilot'));
  });
});

describe('panel-service.ts — plainMaskedKey', () => {
  it('masks short, empty, and long keys', () => {
    expect(plainMaskedKey('')).toBe('—');
    expect(plainMaskedKey('abc')).toBe('•••');
    expect(plainMaskedKey('abcdefgh')).toBe('••••••••');
    expect(plainMaskedKey('sk-1234567890abcdef')).toBe('sk-1…cdef');
  });
});

import type { AuthPanelServiceDeps } from '../src/auth-menu/panel-service.js';
// ── panel-service host with mocked config utils ──────────────────────────
// NOTE: the vi.mock calls below MUST use the `vi` identifier (not an alias)
// so vitest's hoisting transformer moves them above the imports.
import { createAuthPanelHost } from '../src/auth-menu/panel-service.js';

const configMock = vi.hoisted(() => ({
  loadConfigProviders: vi.fn(),
  mutateConfigProviders: vi.fn(),
}));

vi.mock('../src/provider-config-utils.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfigProviders: configMock.loadConfigProviders,
    mutateConfigProviders: configMock.mutateConfigProviders,
  };
});

const registryMock = vi.hoisted(() => ({
  listProviders: vi.fn(),
}));

vi.mock('@wrongstack/core/coordination', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    ModelsRegistry: class {
      listProviders = registryMock.listProviders;
    },
  };
});

function panelDeps(): AuthPanelServiceDeps {
  return {
    vault: {} as never,
    modelsRegistry: { listProviders: registryMock.listProviders } as never,
    profileConfigPath: '/tmp/profile.json',
  };
}

describe('panel-service.ts — host', () => {
  beforeEach(() => {
    configMock.loadConfigProviders.mockReset();
    configMock.mutateConfigProviders.mockReset();
    registryMock.listProviders.mockReset();
  });

  it('listProviders returns rows with masked keys and active markers', async () => {
    configMock.loadConfigProviders.mockResolvedValue({
      openai: {
        type: 'openai',
        family: 'openai',
        activeKey: 'work',
        apiKeys: [
          { label: 'work', apiKey: 'sk-aaaa1111bbbb2222', createdAt: '2020-01-01T00:00:00.000Z' },
          { label: 'home', apiKey: 'sk-cccc3333dddd4444', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
      },
    });
    const host = createAuthPanelHost(panelDeps());
    const rows = await host.listProviders();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('openai');
    expect(rows[0]!.keys[0]!.label).toBe('work');
    expect(rows[0]!.keys[0]!.active).toBe(true);
    expect(rows[0]!.keys[1]!.active).toBe(false);
    expect(rows[0]!.keys[0]!.masked).toBe('sk-a…2222');
  });

  it('listCatalog filters unsupported families and sorts by id', async () => {
    registryMock.listProviders.mockResolvedValue([
      { id: 'zebra', family: 'openai', envVars: [], models: [] },
      { id: 'alpha', family: 'unsupported', envVars: [], models: [] },
      { id: 'beta', family: 'google', envVars: [], models: [] },
    ]);
    configMock.loadConfigProviders.mockResolvedValue({});
    const host = createAuthPanelHost(panelDeps());
    const rows = await host.listCatalog();
    // The registry catalog is merged with WrongStack's own built-in provider
    // definitions (ownDefinitionsAsCatalog), so assert on the registry-derived
    // rows rather than the exact full list.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('beta');
    expect(ids).toContain('zebra');
    expect(ids).not.toContain('alpha');
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('setActiveKey and deleteKey mutate through the config utils', async () => {
    configMock.mutateConfigProviders.mockImplementation(async (_p, _v, mutator) => {
      const providers: Record<string, ProviderConfig> = {
        openai: {
          type: 'openai',
          apiKeys: [{ label: 'work', apiKey: 'k1', createdAt: '2020-01-01T00:00:00.000Z' }],
        },
      };
      // The real mutateConfigProviders hands the mutator the full decrypted
      // config as a second argument (provider-config-utils.ts) — removeProvider
      // now uses it to clean up fallback references.
      mutator(providers, {});
    });
    const host = createAuthPanelHost(panelDeps());
    await expect(host.setActiveKey('openai', 'work')).resolves.toBeNull();
    await expect(host.deleteKey('openai', 'work')).resolves.toBeNull();
    await expect(host.removeProvider('openai')).resolves.toBeNull();
  });

  it('localPresets exposes the local provider presets', () => {
    const host = createAuthPanelHost(panelDeps());
    const presets = host.localPresets();
    expect(presets.length).toBeGreaterThan(0);
  });
});
