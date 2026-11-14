import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginDevWatchController } from '../src/plugin-management/plugin-watch.js';

describe('PluginDevWatchController dispose fencing', () => {
  it('does not register an FSWatcher when disposed while watch() is in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-plugin-watch-dispose-'));
    try {
      const pluginDir = join(root, 'plugins', 'demo-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }),
      );
      writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

      const controller = new PluginDevWatchController();
      const pending = controller.watch('demo-plugin', {
        globalRoot: root,
        onReload: async () => {},
      });
      controller.dispose();
      await pending;

      expect(controller.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
