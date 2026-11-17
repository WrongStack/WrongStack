import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginDevWatchController } from '../src/plugin-management/plugin-watch.js';

describe('PluginDevWatchController watcher error handling', () => {
  it('routes FSWatcher error events to opts.onError instead of throwing an uncaught exception', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-watch-err-'));
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const errors: Array<{ name: string; err: unknown }> = [];
    const controller = new PluginDevWatchController();
    try {
      await controller.watch('demo-plugin', {
        globalRoot: root,
        onReload: async () => {},
        onError: (name, err) => errors.push({ name, err }),
      });

      const entry = (
        controller as unknown as { watches: Map<string, { watcher: NodeJS.EventEmitter }> }
      ).watches.get('demo-plugin');
      expect(entry).toBeDefined();

      entry!.watcher.emit('error', new Error('ENOSPC'));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.name).toBe('demo-plugin');
    } finally {
      controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
