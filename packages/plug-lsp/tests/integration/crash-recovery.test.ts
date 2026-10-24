import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import { makeLSPTools } from '../../src/tools/index.js';
import type { PlugLSPConfig } from '../../src/types.js';

const fixtureServer = fileURLToPath(
  new URL('./fixtures/crash-once-lsp-server.mjs', import.meta.url),
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

describe('crash recovery', () => {
  it('restarts a crashed server and reopens tracked documents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-crash-'));
    const marker = path.join(root, 'crash-once');
    await fs.writeFile(marker, '1');
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    const source = path.join(root, 'sample.ts');
    await fs.writeFile(source, 'const answer = 42;\n');

    const cfg: PlugLSPConfig = {
      servers: {
        crashy: {
          command: process.execPath,
          args: [fixtureServer, marker],
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
    const events = new EventBus();
    let crashes = 0;
    events.on('lsp.server.crashed', () => {
      crashes++;
    });
    const registry = new LSPRegistry(cfg, tracker, { cwd: root, log, events });
    holder.registry = registry;
    await registry.bind(root, 'lazy');
    await registry.findForPath(source, new AbortController().signal);
    await tracker.open(source);

    // The first instance reports `ready` and exits 25ms later. A fixed sleep
    // before polling for `ready` let a loaded coverage run see that first
    // instance still `ready` and send the request into the dying process.
    await waitFor(() => crashes > 0, 5000);
    await waitFor(async () => registry.get('crashy')?.state === 'ready', 5000);

    const tools = new Map(
      makeLSPTools({ registry, tracker, cfg, log }).map((tool) => [tool.name, tool]),
    );
    const definition = await tools
      .get('lsp_definition')!
      .execute({ path: source, line: 1, character: 7 }, { cwd: root, projectRoot: root } as never, {
        signal: new AbortController().signal,
      });
    expect(String(definition)).toContain('sample.ts:1:1');

    await registry.shutdown();
  }, 10_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}
