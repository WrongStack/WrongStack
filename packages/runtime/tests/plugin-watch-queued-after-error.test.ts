import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginDevWatchController } from '../src/plugin-management/plugin-watch.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PluginDevWatchController coalesced reload after failure', () => {
  it('continues draining state.queued when an earlier reload throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-watch-queued-err-'));
    const pluginDir = join(root, 'plugins', 'demo-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default 0;\n');

    let onDebounceFired: (() => void) | null = null;
    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) =>
      origSetTimeout(() => {
        fn(...rest);
        if (ms === 40) onDebounceFired?.();
      }, ms),
    );

    const reload1Entered = deferred<void>();
    const gate1 = deferred<void>();
    const reload2Done = deferred<void>();
    let reloadCalls = 0;
    const errors: unknown[] = [];
    const controller = new PluginDevWatchController();

    try {
      await controller.watch('demo-plugin', {
        globalRoot: root,
        debounceMs: 40,
        onReload: async () => {
          reloadCalls += 1;
          if (reloadCalls === 1) {
            reload1Entered.resolve();
            await gate1.promise;
          } else {
            reload2Done.resolve();
          }
        },
        onError: (_name, err) => errors.push(err),
      });

      const state = (
        controller as unknown as { watches: Map<string, { queued: boolean; running: boolean }> }
      ).watches.get('demo-plugin')!;

      writeFileSync(join(pluginDir, 'index.js'), 'export default broken(\n');
      await reload1Entered.promise;

      const queuedBarrier = deferred<void>();
      onDebounceFired = () => {
        if (state.queued) queuedBarrier.resolve();
      };
      writeFileSync(join(pluginDir, 'index.js'), 'export default { ok: true };\n');
      await queuedBarrier.promise;
      onDebounceFired = null;

      gate1.reject(new SyntaxError('broken save 1'));
      await reload2Done.promise;
      while (state.running) {
        await new Promise<void>((r) => setImmediate(r));
      }

      expect(reloadCalls).toBe(2);
      expect(errors).toHaveLength(1);
      expect(state.queued).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      controller.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
