import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { mergeConfig } from '../../src/config.js';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPServer } from '../../src/server/lsp-server.js';
import { createDiagnosticsTool } from '../../src/tools/diagnostics.js';
import type { ToolDeps } from '../../src/tools/shared.js';
import { pathToUri } from '../../src/utils/uri.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-verification-'));
  const file = path.join(root, 'a.ts');
  await fs.writeFile(file, 'const a = 1;');
  const log = { debug() {}, warn() {} } as unknown as Logger;
  const server = new LSPServer(
    'probe',
    { command: 'unused', languages: ['typescript'] },
    {
      cwd: root,
      rootPath: root,
      log,
      events: new EventBus(),
    },
  );
  server.state = 'ready';
  const registry = { list: () => [server], findForPath: async () => server };
  const tracker = new DocumentTracker(() => registry, log, root);
  const tool = createDiagnosticsTool({
    registry,
    tracker,
    log,
    cfg: mergeConfig({ diagnosticsWaitMs: 10 }),
  } as unknown as ToolDeps);
  const execute = (input: { path?: string } = { path: file }) =>
    tool.execute(input, { cwd: root } as never, { signal: new AbortController().signal });
  const publish = (target = file) =>
    (
      server as unknown as {
        setDiagnostics(uri: string, diagnostics: unknown[]): void;
      }
    ).setDiagnostics(pathToUri(target), []);
  return { file, server, tracker, execute, publish };
}

describe('diagnostics verification evidence', () => {
  it('does not report a silent push server as a clean file', async () => {
    const { execute } = await fixture();
    await expect(execute()).rejects.toThrow(/not been verified/);
  });

  it('reports the server and scope for a confirmed clean file', async () => {
    const { file, tracker, publish, execute } = await fixture();
    await tracker.open(file);
    publish();
    expect(await execute()).toContain('probe');
  });

  it('rejects an empty workspace sweep instead of claiming it is clean', async () => {
    const { execute } = await fixture();
    await expect(execute({})).rejects.toThrow(/No tracked/);
  });

  it('waits for every workspace document, including later documents on the same server', async () => {
    const { file, tracker, publish, execute } = await fixture();
    await tracker.open(file);
    publish();
    const second = path.join(path.dirname(file), 'b.ts');
    await fs.writeFile(second, 'const b = 2;');
    await tracker.open(second);
    await expect(execute({})).rejects.toThrow(/not been verified/);
  });

  it('does not query pull diagnostics for an unreadable document', async () => {
    const { file, server, execute } = await fixture();
    server.capabilities = {
      diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    };
    const pull = vi.spyOn(server, 'pullDiagnostics').mockResolvedValue([]);
    await fs.unlink(file);
    await expect(execute()).rejects.toThrow(/Could not open/);
    expect(pull).not.toHaveBeenCalled();
  });
});
