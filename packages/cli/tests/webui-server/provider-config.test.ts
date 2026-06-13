import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProviderConfigStore,
  getVault,
  loadSavedProviders,
  maskedKey,
  normalizeKeys,
  saveProviders,
} from '../../src/webui-server/provider-config.js';

/**
 * PR 4 of Issue #30 (webui-server 8-PR refactor):
 * provider-config IO unit tests.
 *
 * These cover the three helpers extracted from
 * webui-server.ts:
 *
 *   - getVault: builds a DefaultSecretVault rooted at
 *     <dirname(globalConfigPath)>/.key
 *   - loadSavedProviders: returns {} when no
 *     globalConfigPath, otherwise the on-disk map
 *     (decrypted via the vault)
 *   - saveProviders: no-op when no globalConfigPath,
 *     otherwise replaces the entire providers map
 *
 * Tests use real on-disk temp files in
 * os.tmpdir() — no mocking of the vault or
 * loadConfigProviders. The point of this PR is to
 * decouple the helpers from the `runWebUI` closure;
 * the helpers themselves are still integration-tested
 * with the underlying fs/cipher stack.
 */

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pr4-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
  configPath = '';
});

describe('webui-server/provider-config (PR 4 of #30)', () => {
  it('getVault: returns a DefaultSecretVault rooted at dirname(configPath)/.key', () => {
    const v = getVault(configPath);
    expect(v).toBeDefined();
    // DefaultSecretVault is the only thing exported
    // from @wrongstack/core/security that has a
    // keyFile; we don't introspect further, just
    // assert it's truthy.
  });

  it('getVault: tolerates undefined configPath', () => {
    const v = getVault(undefined);
    expect(v).toBeDefined();
  });

  it('loadSavedProviders: returns {} when no globalConfigPath', async () => {
    const out = await loadSavedProviders(undefined);
    expect(out).toEqual({});
  });

  it('loadSavedProviders: returns {} when config file is absent', async () => {
    // configPath exists as a path but no file at
    // it yet. loadConfigProviders treats that as
    // an empty config.
    const out = await loadSavedProviders(configPath);
    expect(out).toEqual({});
  });

  it('saveProviders + loadSavedProviders round-trip', async () => {
    // The vault encrypts the keys, so save+load
    // should return the same map. We don't
    // introspect the on-disk format — the
    // round-trip is the contract.
    const input = {
      anthropic: { type: 'anthropic', apiKeys: [{ label: 'k1', key: 'sk-test-1' }] },
      openai: { type: 'openai', apiKeys: [{ label: 'k2', key: 'sk-test-2' }] },
    } as never;
    await saveProviders(configPath, input);
    const out = await loadSavedProviders(configPath);
    expect(out).toEqual(input);
  });

  it('saveProviders: no-op when no globalConfigPath', async () => {
    // The function must not throw, must not create
    // any files, and must not write to anything.
    await expect(saveProviders(undefined, {})).resolves.toBeUndefined();
  });
});

describe('webui-server/provider-config facade (PR 4 follow-up of #30)', () => {
  it('re-exports the provider-record transforms (single import surface)', () => {
    expect(typeof normalizeKeys).toBe('function');
    expect(typeof maskedKey).toBe('function');
    // maskedKey never returns the plaintext.
    expect(maskedKey('sk-supersecret-value')).not.toContain('supersecret');
  });

  it('createProviderConfigStore: load/save round-trip bound to one path', async () => {
    const store = createProviderConfigStore(configPath);
    const input = {
      anthropic: { type: 'anthropic', apiKeys: [{ label: 'k1', key: 'sk-test-1' }] },
    } as never;
    await store.save(input);
    expect(await store.load()).toEqual(input);
    // The store is just a binding over the same IO.
    expect(await loadSavedProviders(configPath)).toEqual(input);
  });

  it('createProviderConfigStore: no-op store when path is undefined', async () => {
    const store = createProviderConfigStore(undefined);
    expect(await store.load()).toEqual({});
    await expect(store.save({})).resolves.toBeUndefined();
  });
});
