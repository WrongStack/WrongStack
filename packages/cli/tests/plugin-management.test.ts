import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from '../src/plugin-management.js';

let tmpDir: string;
let configPath: string;

const testDir = path.dirname(fileURLToPath(import.meta.url));

function config(overrides: Partial<Config> = {}): Config {
  return {
    features: { plugins: true },
    ...overrides,
  } as Config;
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plugin-mgmt-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('plugin management', () => {
  it('exports audit entries for the TUI plugin picker', () => {
    expect(PLUGIN_AUDIT_ENTRIES.length).toBeGreaterThan(0);
    expect(PLUGIN_AUDIT_ENTRIES.every((entry) => entry.canDisable)).toBe(true);
    expect(PLUGIN_AUDIT_ENTRIES).toContainEqual(
      expect.objectContaining({
        name: 'secret-scanner',
        canDisable: true,
        defaultState: 'active',
      }),
    );
    expect(PLUGIN_AUDIT_ENTRIES).toContainEqual(
      expect.objectContaining({
        name: 'branch-guard',
        canDisable: true,
        defaultState: 'active',
      }),
    );
    expect(PLUGIN_AUDIT_ENTRIES).toContainEqual(
      expect.objectContaining({
        name: 'cost-tracker',
        canDisable: true,
        defaultState: 'active',
      }),
    );
  });

  it('includes every bundled @wrongstack/plugins source directory in the TUI plugin picker audit list', async () => {
    const pluginSrc = path.resolve(testDir, '..', '..', 'plugins', 'src');
    const bundledPluginDirs = (
      await Promise.all(
        (await fs.readdir(pluginSrc, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const indexPath = path.join(pluginSrc, entry.name, 'index.ts');
            try {
              await fs.access(indexPath);
              return entry.name;
            } catch {
              return null;
            }
          }),
      )
    )
      .filter((name): name is string => Boolean(name))
      .sort();
    const pickerNames = new Set(PLUGIN_AUDIT_ENTRIES.map((entry) => entry.name));

    expect(bundledPluginDirs.filter((name) => !pickerNames.has(name))).toEqual([]);
  });

  it('toggles a default-active plugin off by writing a disabled override', async () => {
    await fs.writeFile(configPath, JSON.stringify({ features: { plugins: true } }));

    const result = await runPluginManagementCommand(['toggle', 'cost-tracker'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual([{ name: 'cost-tracker', enabled: false }]);
    expect(result.patch?.features).toMatchObject({ plugins: true });
    await expect(readConfig()).resolves.toMatchObject({
      plugins: [{ name: 'cost-tracker', enabled: false }],
      features: { plugins: true },
    });
  });

  it('toggles a disabled default-active plugin back on by removing the override', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        features: { plugins: true },
        plugins: [{ name: 'cost-tracker', enabled: false }, 'agent-handoff'],
      }),
    );

    const result = await runPluginManagementCommand(['toggle', 'cost-tracker'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual(['agent-handoff']);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: ['agent-handoff'],
      features: { plugins: true },
    });
  });

  it('toggles a default-inactive plugin on by writing an enabled entry', async () => {
    await fs.writeFile(configPath, JSON.stringify({ features: { plugins: true } }));

    const result = await runPluginManagementCommand(['toggle', 'format-on-save'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual(['format-on-save']);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: ['format-on-save'],
      features: { plugins: true },
    });
  });

  it('toggles an enabled default-inactive plugin back off by removing the entry', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ features: { plugins: true }, plugins: ['format-on-save', 'agent-handoff'] }),
    );

    const result = await runPluginManagementCommand(['toggle', 'format-on-save'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual(['agent-handoff']);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: ['agent-handoff'],
      features: { plugins: true },
    });
  });

  it('toggles secret-scanner off by writing a disabled override', async () => {
    await fs.writeFile(configPath, JSON.stringify({ plugins: [] }));

    const result = await runPluginManagementCommand(['toggle', 'secret-scanner'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual([{ name: 'secret-scanner', enabled: false }]);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: [{ name: 'secret-scanner', enabled: false }],
      features: { plugins: true },
    });
  });

  it('toggles a default-active core plugin off by writing a disabled override', async () => {
    await fs.writeFile(configPath, JSON.stringify({ plugins: [] }));

    const result = await runPluginManagementCommand(['toggle', 'wstack-git'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual([{ name: 'wstack-git', enabled: false }]);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: [{ name: 'wstack-git', enabled: false }],
      features: { plugins: true },
    });
  });

  it('toggles branch-guard off by writing a disabled override', async () => {
    await fs.writeFile(configPath, JSON.stringify({ features: { plugins: true } }));

    const result = await runPluginManagementCommand(['toggle', 'branch-guard'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.restartRequired).toBeUndefined();
    expect(result.message).toContain('disable itself');
    expect(result.patch?.plugins).toEqual([{ name: 'branch-guard', enabled: false }]);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: [{ name: 'branch-guard', enabled: false }],
      features: { plugins: true },
    });
  });

  it('disables branch-guard without requiring restart', async () => {
    await fs.writeFile(configPath, JSON.stringify({ features: { plugins: true } }));

    const result = await runPluginManagementCommand(['disable', 'branch-guard'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.restartRequired).toBeUndefined();
    expect(result.message).toContain('disable itself');
    expect(result.patch?.plugins).toEqual([{ name: 'branch-guard', enabled: false }]);
  });

  it('renders a plugin audit report with effective state and toggle policy', async () => {
    const result = await runPluginManagementCommand(['report'], {
      config: config({
        plugins: [{ name: 'format-on-save', enabled: false }, 'cost-tracker', 'external-plugin'],
      }),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.message).toContain('Plugin audit report');
    expect(result.message).toContain('secret-scanner');
    expect(result.message).toContain('toggleable');
    expect(result.message).not.toContain('locked: safety guard');
    expect(result.message).toContain('format-on-save');
    expect(result.message).toContain('disabled config');
    expect(result.message).toContain('cost-tracker');
    expect(result.message).toContain('enabled  config');
    expect(result.message).toContain('external-plugin');
    expect(result.message).toContain('risk=custom');
  });

  it('uses the audit report as the non-interactive menu fallback', async () => {
    const result = await runPluginManagementCommand(['menu'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.message).toContain('Plugin audit report');
    expect(result.message).toContain('/plugin menu');
  });

  it('llm set writes a per-plugin provider/model override and patches extensions', async () => {
    await fs.writeFile(configPath, JSON.stringify({ features: { plugins: true } }));

    const result = await runPluginManagementCommand(
      ['llm', 'error-lens', 'omniroute', 'qwen3-30b'],
      {
        config: config({ provider: 'anthropic', model: 'claude-fable-5' } as Partial<Config>),
        configPath,
      },
    );

    expect(result.code).toBe(0);
    expect(result.restartRequired).toBeUndefined(); // hot-reloaded via ConfigStore, no restart
    expect(result.message).toContain('provider=omniroute');
    expect(result.message).toContain('model=qwen3-30b');
    expect(result.patch?.extensions).toMatchObject({
      'error-lens': { llm: { provider: 'omniroute', model: 'qwen3-30b' } },
    });
    await expect(readConfig()).resolves.toMatchObject({
      extensions: { 'error-lens': { llm: { provider: 'omniroute', model: 'qwen3-30b' } } },
    });
  });

  it('llm with "-" provider overrides only the model', async () => {
    await fs.writeFile(configPath, JSON.stringify({}));

    const result = await runPluginManagementCommand(['llm', 'changelog-writer', '-', 'haiku-x'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    await expect(readConfig()).resolves.toMatchObject({
      extensions: { 'changelog-writer': { llm: { model: 'haiku-x' } } },
    });
    const ext = result.patch?.extensions?.['changelog-writer'] as { llm?: Record<string, unknown> };
    expect(ext.llm).toEqual({ model: 'haiku-x' });
  });

  it('llm set preserves sibling extension options for the same plugin', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ extensions: { 'error-lens': { aiHints: true } } }),
    );

    await runPluginManagementCommand(['llm', 'error-lens', 'openai'], {
      config: config(),
      configPath,
    });

    await expect(readConfig()).resolves.toMatchObject({
      extensions: { 'error-lens': { aiHints: true, llm: { provider: 'openai' } } },
    });
  });

  it('llm show reports the current override or the session default', async () => {
    const shown = await runPluginManagementCommand(['llm', 'error-lens'], {
      config: config({
        provider: 'anthropic',
        model: 'claude-fable-5',
        extensions: { 'error-lens': { llm: { provider: 'omniroute', model: 'm1' } } },
      } as Partial<Config>),
      configPath,
    });
    expect(shown.code).toBe(0);
    expect(shown.message).toContain('provider=omniroute');
    expect(shown.message).toContain('anthropic / claude-fable-5');

    const empty = await runPluginManagementCommand(['llm', 'dep-guard'], {
      config: config({ provider: 'anthropic', model: 'claude-fable-5' } as Partial<Config>),
      configPath,
    });
    expect(empty.message).toContain('no override');
  });

  it('llm --clear removes the override from file and patch', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        extensions: { 'error-lens': { aiHints: true, llm: { provider: 'omniroute' } } },
      }),
    );

    const result = await runPluginManagementCommand(['llm', 'error-lens', '--clear'], {
      config: config({
        extensions: { 'error-lens': { aiHints: true, llm: { provider: 'omniroute' } } },
      } as Partial<Config>),
      configPath,
    });

    expect(result.code).toBe(0);
    const written = await readConfig();
    expect((written.extensions as Record<string, Record<string, unknown>>)['error-lens']).toEqual({
      aiHints: true,
    });
    const patched = result.patch?.extensions?.['error-lens'] as Record<string, unknown>;
    expect(patched).toBeDefined();
    expect('llm' in patched).toBe(false);
    expect(patched['aiHints']).toBe(true);
  });

  it('bare "llm" lists every configured override', async () => {
    const result = await runPluginManagementCommand(['llm'], {
      config: config({
        provider: 'anthropic',
        model: 'claude-fable-5',
        extensions: {
          'error-lens': { llm: { provider: 'omniroute', model: 'qwen3-30b' } },
          'changelog-writer': { llm: { model: 'haiku-x' } },
          'dep-guard': { aiHints: false }, // no llm key → not listed
        },
      } as Partial<Config>),
      configPath,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain('error-lens');
    expect(result.message).toContain('provider=omniroute');
    expect(result.message).toContain('changelog-writer');
    expect(result.message).toContain('model=haiku-x');
    expect(result.message).not.toContain('dep-guard');
    expect(result.message).toContain('anthropic / claude-fable-5');
  });

  it('bare "llm" reports when no overrides exist', async () => {
    const result = await runPluginManagementCommand(['llm'], {
      config: config({ provider: 'anthropic', model: 'claude-fable-5' } as Partial<Config>),
      configPath,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain('No plugin overrides');
  });

  it('canonicalizes the legacy Telegram package spec when toggling', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        features: { plugins: true },
        plugins: ['@wrongstack/telegram'],
      }),
    );

    const result = await runPluginManagementCommand(['toggle', '@wrongstack/telegram'], {
      config: config(),
      configPath,
    });

    expect(result.code).toBe(0);
    expect(result.patch?.plugins).toEqual([]);
    await expect(readConfig()).resolves.toMatchObject({
      plugins: [],
    });
  });
});
