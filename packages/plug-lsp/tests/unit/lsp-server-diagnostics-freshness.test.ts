import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { LSPServer } from '../../src/server/lsp-server.js';

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

function makeServer() {
  return new LSPServer(
    'probe',
    { command: process.execPath, languages: ['typescript'] },
    { cwd: process.cwd(), rootPath: process.cwd(), log, events: new EventBus() },
  );
}

type Internals = {
  state: string;
  diagnosticsFresh: Set<string>;
  setDiagnostics(uri: string, diagnostics: unknown[]): void;
};

// Regression: `diagnosticsFresh` was never evicted alongside `diagnostics`, so
// it grew for the life of the server and an evicted URI was treated as fresh,
// making waitForDiagnostics return an empty buffer without waiting.
describe('LSPServer diagnostics freshness retention', () => {
  it('evicts freshness with the buffer and no longer short-circuits an evicted URI', async () => {
    const server = makeServer();
    const internal = server as unknown as Internals;
    internal.state = 'ready';

    const total = LSPServer.MAX_DIAGNOSTICS_ENTRIES + 50;
    for (let i = 0; i < total; i++) {
      internal.setDiagnostics(`file:///doc-${i}.ts`, [{ severity: 1, message: `d${i}` }]);
    }

    expect(server.diagnostics.size).toBe(LSPServer.MAX_DIAGNOSTICS_ENTRIES);
    expect(internal.diagnosticsFresh.size).toBeLessThanOrEqual(LSPServer.MAX_DIAGNOSTICS_ENTRIES);

    const evictedUri = 'file:///doc-0.ts';
    expect(internal.diagnosticsFresh.has(evictedUri)).toBe(false);

    // The evicted URI must wait for a republish rather than return stale [].
    const republish = setTimeout(() => {
      internal.setDiagnostics(evictedUri, [{ severity: 1, message: 'republished' }]);
    }, 20);
    const diagnostics = await server.waitForDiagnostics(evictedUri, 1000);
    clearTimeout(republish);
    expect(diagnostics).toHaveLength(1);
    expect(internal.diagnosticsFresh.has(evictedUri)).toBe(true);

    // The newest URI is still buffered and must remain immediately available.
    const newestUri = `file:///doc-${total - 1}.ts`;
    expect(await server.waitForDiagnostics(newestUri, 1000)).toHaveLength(1);

    // Closing a document still clears both maps.
    server.notifyDidClose(newestUri);
    expect(server.getDiagnostics(newestUri)).toEqual([]);
    expect(internal.diagnosticsFresh.has(newestUri)).toBe(false);
  });
});
