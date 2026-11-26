import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { mergeConfig } from '../../src/config.js';
import { DocumentTracker } from '../../src/document-tracker.js';
import { createDiagnosticsTool } from '../../src/tools/diagnostics.js';
import type { ToolDeps } from '../../src/tools/shared.js';
import { pathToUri } from '../../src/utils/uri.js';

function diagnostic(message: string) {
  return {
    message,
    severity: 1,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };
}

it.each(['first', 'second'] as const)(
  'keeps tracked-file order when the %s response arrives first',
  async (arrival) => {
    const cwd = await mkdtemp(join(tmpdir(), 'lsp-order-'));
    const first = {
      path: join(cwd, 'a.ts'),
      reply: Promise.withResolvers<ReturnType<typeof diagnostic>[]>(),
      message: 'diagnostic for A',
    };
    const second = {
      path: join(cwd, 'b.ts'),
      reply: Promise.withResolvers<ReturnType<typeof diagnostic>[]>(),
      message: 'diagnostic for B',
    };
    const bothRequested = Promise.withResolvers<void>();
    const requested: string[] = [];
    const server = {
      name: 'probe',
      waitForDiagnostics(uri: string) {
        requested.push(uri);
        if (requested.length === 2) bothRequested.resolve();
        return (uri === pathToUri(first.path) ? first : second).reply.promise;
      },
    };
    const registry = { list: () => [], findForPath: async () => server };
    const log = { debug() {}, warn() {} } as unknown as ToolDeps['log'];
    const tracker = new DocumentTracker(() => registry, log, cwd);
    const tool = createDiagnosticsTool({
      registry: registry as unknown as ToolDeps['registry'],
      tracker,
      cfg: mergeConfig({}),
      log,
    });
    try {
      for (const file of [first, second]) {
        await writeFile(file.path, 'const value = 1;\n');
        expect(await tracker.open(file.path)).toBe(true);
      }
      const output = tool.execute({ limit: 1 }, { cwd } as Parameters<typeof tool.execute>[1], {
        signal: new AbortController().signal,
      });
      // Fail immediately if the tool errors before issuing both requests.
      await Promise.race([bothRequested.promise, output]);
      expect(requested).toEqual([pathToUri(first.path), pathToUri(second.path)]);
      const early = arrival === 'first' ? first : second;
      const late = arrival === 'first' ? second : first;
      early.reply.resolve([diagnostic(early.message)]);
      await Promise.resolve();
      late.reply.resolve([diagnostic(late.message)]);
      const result = await output;
      expect(result).toContain('Total: 1 diagnostics in 1 files.');
      expect(result).toContain(first.message);
      expect(result).not.toContain(second.message);
    } finally {
      first.reply.resolve([]);
      second.reply.resolve([]);
      await rm(cwd, { recursive: true, force: true });
    }
  },
  5_000,
);
