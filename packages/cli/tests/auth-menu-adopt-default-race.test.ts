/**
 * Round r2-adopt-default-rmw-20260903 — lost-update race regression test.
 *
 * `adoptAsDefaultIfUnset` (packages/cli/src/auth-menu/add-provider.ts) reads
 * the raw config file, then awaits a models-registry catalog lookup, then
 * rewrites the ENTIRE file from its stale parse via `atomicWrite`. Any
 * concurrent config mutation that lands inside that read→write window
 * (another CLI operation, the WebUI server process, another tab) is
 * silently clobbered — a classic lost update. The window is unbounded:
 * the catalog lookup is a network-shaped await.
 *
 * Deterministic interleaving: `getProvider` is only called AFTER the raw
 * read, so parking the registry promise there guarantees the concurrent
 * mutation below executes strictly between the read and the write.
 *
 * Drives the REAL `addKeyForProvider` flow: real temp-dir config file,
 * real `DefaultSecretVault`, real `mutateConfigProviders` — only the
 * models registry is a test double (it is an injected dependency).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { addKeyForProvider } from '../src/auth-menu/add-provider.js';
import { mutateConfigProviders } from '../src/provider-config-utils.js';
import type { AuthMenuDeps } from '../src/auth-menu/types.js';

function silentRenderer(): AuthMenuDeps['renderer'] {
  return { write() {}, writeInfo() {}, writeWarning() {}, writeError() {} };
}

describe('adoptAsDefaultIfUnset concurrent-mutation safety', () => {
  it('does not clobber a config mutation that lands during default adoption', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-adopt-race-'));
    const configPath = path.join(tmpDir, 'config.json');
    // No top-level provider/model → the flow will try to adopt defaults.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        marker: 'keep-me',
        providers: {
          other: {
            type: 'openai',
            family: 'openai',
            keys: [{ label: 'old', apiKey: 'sk-old', createdAt: '2026-01-01T00:00:00.000Z' }],
            activeKey: 'old',
          },
        },
      }),
      { mode: 0o600 },
    );

    const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });

    // Gate that parks the flow inside adoptAsDefaultIfUnset's read→write
    // window until this test releases it.
    let releaseCatalog!: (value: ResolvedProvider | undefined) => void;
    const catalogGate = new Promise<ResolvedProvider | undefined>((resolve) => {
      releaseCatalog = resolve;
    });
    let catalogCalled = false;
    const registry = {
      getProvider: () => {
        catalogCalled = true;
        return catalogGate;
      },
      listProviders: async () => [] as ResolvedProvider[],
      getModel: async () => undefined,
      suggestModel: async () => undefined,
      refresh: async () => undefined,
    } as never as ModelsRegistry;

    const deps: AuthMenuDeps = {
      renderer: silentRenderer(),
      reader: {
        readLine: async () => 'k1',
        readSecret: async () => 'sk-newprovider-123',
      },
      modelsRegistry: registry,
      vault,
      profileConfigPath: configPath,
    };

    const flow = addKeyForProvider('newprov', deps, { type: 'newprov' });

    // The catalog gate is reached only after the key-save mutation AND the
    // adoption's raw file read — poll for it instead of guessing timings.
    const deadline = Date.now() + 10_000;
    while (!catalogCalled) {
      if (Date.now() > deadline) throw new Error('flow never reached the catalog gate');
      await new Promise((r) => setTimeout(r, 10));
    }

    // Concurrent mutation — exactly what any other `mutateConfigProviders`
    // caller (other CLI operation, WebUI server process) does at any time.
    await mutateConfigProviders(configPath, vault, (all) => {
      all['third'] = { type: 'openai', family: 'openai' };
    });

    // Resume the flow: the catalog answers, adoption resumes with its STALE
    // parse and rewrites the whole file.
    releaseCatalog({ models: [{ id: 'm1' }] } as never as ResolvedProvider);
    expect(await flow).toBe(true);

    const final = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      marker?: unknown;
      provider?: unknown;
      model?: unknown;
      providers?: Record<string, Record<string, unknown>>;
    };
    const providers = final.providers ?? {};

    // The concurrent mutation must survive the default adoption.
    expect(
      providers['third'],
      'LOST UPDATE: the concurrent mutateConfigProviders change was clobbered by adoptAsDefaultIfUnset stale whole-file rewrite',
    ).toBeDefined();
    expect(final.marker, 'unrelated top-level config keys must survive').toBe('keep-me');
    expect(providers['other']).toBeDefined();
    // …and the adoption itself must still have happened (a fix may not
    // simply disable default adoption).
    expect(final.provider).toBe('newprov');
    expect(final.model).toBe('m1');
    expect(providers['newprov']).toBeDefined();
  });
});
