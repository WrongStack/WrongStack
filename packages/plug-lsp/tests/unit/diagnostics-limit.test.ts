import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeConfig } from '../../src/config.js';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPServer } from '../../src/server/lsp-server.js';
import { createDiagnosticsTool } from '../../src/tools/diagnostics.js';
import type { ToolDeps } from '../../src/tools/shared.js';
import { pathToUri } from '../../src/utils/uri.js';

/**
 * `lsp_diagnostics { limit: 0 }` (or a negative/fractional limit) exhausted
 * the total budget before the first diagnostic and answered
 * "No LSP diagnostics." for a file the server had flagged — a false clean
 * claim from the tool the system prompt names for verification (F1511).
 */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const diagnostic = (line: number, message: string) => ({
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
  severity: 1,
  message,
});

async function run(limit: number | undefined, diagnostics: unknown[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-diag-limit-'));
  tempDirs.push(root);
  const file = path.join(root, 'a.ts');
  await fs.writeFile(file, 'a;\nb;\nc;\n');
  const log = { debug() {}, warn() {} } as unknown as Logger;
  const server = new LSPServer(
    'probe',
    { command: 'unused', languages: ['typescript'] },
    { cwd: root, rootPath: root, log, events: new EventBus() },
  );
  server.state = 'ready';
  const registry = { list: () => [server], findForPath: async () => server };
  const tracker = new DocumentTracker(() => registry, log, root);
  const tool = createDiagnosticsTool({
    registry,
    tracker,
    log,
    cfg: mergeConfig({ diagnosticsWaitMs: 10, maxDiagnosticsTotal: 2 }),
  } as unknown as ToolDeps);
  await tracker.open(file);
  (
    server as unknown as { setDiagnostics(uri: string, diagnostics: unknown[]): void }
  ).setDiagnostics(pathToUri(file), diagnostics);
  return await tool.execute(
    limit === undefined ? { path: file } : { path: file, limit },
    {
      cwd: root,
    } as never,
    { signal: new AbortController().signal },
  );
}

const three = [diagnostic(0, 'e0'), diagnostic(1, 'e1'), diagnostic(2, 'e2')];

describe('lsp_diagnostics limit', () => {
  it.each([0, -1, 0.5])('limit %s never reports a flagged file as clean', async (limit) => {
    const out = await run(limit, three);
    expect(out).not.toContain('No LSP diagnostics');
    expect(out).toContain('ERROR: e0');
    expect(out).toContain('Total: 1 diagnostics');
  });

  it('keeps positive limits, the config default and a truly clean file', async () => {
    expect(await run(3, three)).toContain('Total: 3 diagnostics');
    expect(await run(undefined, three)).toContain('Total: 2 diagnostics');
    expect(await run(0, [])).toMatch(/^No LSP diagnostics\./);
  });
});
