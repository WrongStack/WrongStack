import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import { buildLspCommand } from '../../src/slash-commands/lsp.js';
import type { PlugLSPConfig } from '../../src/types.js';

const fixtureServer = fileURLToPath(
  new URL('./fixtures/delayed-shutdown-lsp.mjs', import.meta.url),
);

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

// Regression: `/lsp restart` used to call registry.stop() without awaiting it,
// so the new child was spawned while the old shutdown was still in flight and
// the stale exit handler killed the replacement. The command still reported
// success, leaving every later LSP tool call broken. The fixture delays its
// `shutdown` response specifically to make the race deterministic.
describe('slash-command restart sequencing', () => {
  it('leaves the server ready after restart and awaited after stop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-restart-'));
    await fs.writeFile(path.join(root, 'package.json'), '{}');

    const cfg: PlugLSPConfig = {
      servers: {
        demo: {
          command: process.execPath,
          args: [fixtureServer],
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          startupTimeoutMs: 5000,
          enabled: true,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 100,
      severityFilter: ['error', 'warning'],
      maxDiagnosticsPerFile: 10,
      maxDiagnosticsTotal: 20,
      autoDiscover: false,
      logServerOutput: false,
    };

    const holder: { registry?: LSPRegistry } = {};
    const tracker = new DocumentTracker(() => holder.registry!, log, root);
    const registry = new LSPRegistry(cfg, tracker, { cwd: root, log, events: new EventBus() });
    holder.registry = registry;

    try {
      await registry.bind(root, 'lazy');
      await registry.start('demo');
      expect(registry.get('demo')?.state).toBe('ready');

      const cmd = buildLspCommand({ registry, tracker, cfg, cwd: root } as never);

      const restarted = await cmd.run!('restart demo');
      expect(restarted?.message).toContain('Restarted');
      expect(registry.get('demo')?.state).toBe('ready');

      const restartedAll = await cmd.run!('restart');
      expect(restartedAll?.message).toContain('Restarted');
      expect(registry.get('demo')?.state).toBe('ready');

      const stopped = await cmd.run!('stop demo');
      expect(stopped?.message).toContain('Stopped');
      expect(registry.get('demo')?.state).toBe('exited');
    } finally {
      await registry.shutdown().catch(() => {});
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});
