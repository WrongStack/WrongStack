import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { noOpVault } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_BEHAVIOR_DEFAULTS } from '../../core/src/storage/config-loader/defaults.js';
import { createSettingsAdapter } from '../src/boot/tui-settings-adapter.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(mode?: 'block' | 'text') {
  const directory = mkdtempSync(path.join(tmpdir(), 'wstack-selection-test-'));
  directories.push(directory);
  const config: Config = {
    ...structuredClone(CONFIG_BEHAVIOR_DEFAULTS),
    provider: 'test',
    model: 'test',
    autonomy: { selectionMode: mode },
  };
  const file = path.join(directory, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  const store = new DefaultConfigStore(config);
  const dependencies = {
    configStore: store,
    wpaths: {
      ...resolveWstackPaths({ projectRoot: directory, globalRoot: directory }),
      globalConfig: file,
      inProjectConfig: path.join(directory, 'project.json'),
      profileConfig: () => file,
    },
    vault: noOpVault,
    fleetStreamController: undefined,
    applyLiveSettings: () => {},
  };
  const adapter = createSettingsAdapter(dependencies);
  const restart = () =>
    createSettingsAdapter({
      ...dependencies,
      configStore: new DefaultConfigStore(JSON.parse(readFileSync(file, 'utf8'))),
    });
  return { adapter, file, store, restart };
}

describe('TUI selection preference persistence', () => {
  it('defaults existing profiles without the setting to Block', () => {
    expect(setup().adapter.getSettings().selectionMode).toBe('block');
  });
  it.each(['block', 'text'] as const)(
    'round-trips %s to disk, live state and a restarted adapter',
    async (selectionMode) => {
      const { adapter, file, store, restart } = setup(selectionMode === 'block' ? 'text' : 'block');
      expect(await adapter.saveSettings({ selectionMode })).toBeNull();
      expect(store.get().autonomy?.selectionMode).toBe(selectionMode);
      expect(adapter.getSettings().selectionMode).toBe(selectionMode);
      const persisted: Config = JSON.parse(readFileSync(file, 'utf8'));
      expect(persisted.autonomy?.selectionMode).toBe(selectionMode);
      expect(restart().getSettings().selectionMode).toBe(selectionMode);
      expect(persisted.provider).toBe('test');
    },
  );
});
