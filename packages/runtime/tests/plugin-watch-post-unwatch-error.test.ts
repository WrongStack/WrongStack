import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginDevWatchController } from '../src/plugin-management/plugin-watch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PluginDevWatchController post-unwatch error fencing', () => {
  it('suppresses onError from in-flight reload rejections after unwatch() or dispose()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-watch-err-fence-'));
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const controller = new PluginDevWatchController();
    const reloadGate = deferred<void>();
    let startedResolve!: () => void;
    const reloadStarted = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const lateErrors: unknown[] = [];
    let unwatched = false;

    try {
      await controller.watch('demo-plugin', {
        globalRoot: root,
        debounceMs: 40,
        onReload: async () => {
          startedResolve();
          await reloadGate.promise;
        },
        onError: (_name, err) => {
          if (unwatched) lateErrors.push(err);
        },
      });

      writeFileSync(join(pluginDir, 'index.js'), 'export default { v: 2 };\n');
      await reloadStarted;

      unwatched = true;
      controller.unwatch('demo-plugin');
      reloadGate.reject(new Error('late failure after unwatch'));

      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(lateErrors).toHaveLength(0);
    } finally {
      controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
