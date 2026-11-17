import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let hashGate: ReturnType<typeof deferred<string>> | null = null;
let hashStarted: (() => void) | null = null;
let pinCalls = 0;

vi.mock('@wrongstack/core/plugin', async (orig) => {
  const actual = await orig<typeof import('@wrongstack/core/plugin')>();
  return {
    ...actual,
    hashPluginDirectoryClosure: async (
      ...args: Parameters<typeof actual.hashPluginDirectoryClosure>
    ) => {
      if (hashGate) {
        hashStarted?.();
        return hashGate.promise;
      }
      return actual.hashPluginDirectoryClosure(...args);
    },
    pinPluginTrust: async (...args: Parameters<typeof actual.pinPluginTrust>) => {
      pinCalls++;
      return actual.pinPluginTrust(...args);
    },
  };
});

const { PluginDevWatchController } = await import('../src/plugin-management/plugin-watch.js');

afterEach(() => {
  hashGate = null;
  hashStarted = null;
  pinCalls = 0;
});

describe('PluginDevWatchController post-unwatch guard', () => {
  it('skips pinPluginTrust and onReload if unwatch() runs while hashing is in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-watch-unwatch-'));
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    let reloadCalls = 0;
    const controller = new PluginDevWatchController();
    try {
      await controller.watch('demo-plugin', {
        globalRoot: root,
        debounceMs: 40,
        onReload: async () => {
          reloadCalls++;
        },
      });

      hashGate = deferred<string>();
      const enteredHash = new Promise<void>((resolve) => {
        hashStarted = resolve;
      });
      writeFileSync(join(pluginDir, 'index.js'), 'export default { v: 2 };\n');
      await enteredHash;

      controller.unwatch('demo-plugin');
      hashGate.resolve('sha256:fake');
      await new Promise((r) => setTimeout(r, 30));

      expect(pinCalls).toBe(0);
      expect(reloadCalls).toBe(0);
    } finally {
      controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
