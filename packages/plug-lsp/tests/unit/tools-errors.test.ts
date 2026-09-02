import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCompletionTool } from '../../src/tools/completion.js';
import { createDefinitionTool } from '../../src/tools/definition.js';
import { createDiagnosticsTool } from '../../src/tools/diagnostics.js';
import { createRenameTool } from '../../src/tools/rename.js';
import {
  resolveInputPath,
  stringifyToolError,
  type ToolDeps,
  textDocumentPosition,
} from '../../src/tools/shared.js';
import { applyWorkspaceEdit } from '../../src/tools/workspace-edit.js';
import { LSPError, LSPErrorCode, type PlugLSPConfig } from '../../src/types.js';
import { pathToUri } from '../../src/utils/uri.js';

const cfg: PlugLSPConfig = {
  servers: {},
  autoStart: 'lazy',
  diagnosticsAfterEdit: 'background',
  diagnosticsWaitMs: 1,
  severityFilter: ['error', 'warning'],
  maxDiagnosticsPerFile: 5,
  maxDiagnosticsTotal: 50,
  autoDiscover: false,
  logServerOutput: false,
};

describe('tool error and edge paths', () => {
  it('formats shared helper paths and errors', () => {
    const cwd = process.cwd();
    expect(resolveInputPath('a.ts', { cwd } as never)).toBe(path.join(cwd, 'a.ts'));
    expect(
      textDocumentPosition(path.join(cwd, 'a.ts'), { line: 1, character: 2 }).textDocument.uri,
    ).toBe(pathToUri(path.join(cwd, 'a.ts')));
    expect(stringifyToolError(new LSPError(LSPErrorCode.ServerFailed, 'failed'))).toContain(
      'LSP_SERVER_FAILED',
    );
    expect(stringifyToolError(new Error('boom'))).toContain('boom');
    expect(stringifyToolError('wat')).toContain('wat');
  });

  it('returns capability and not-found errors from kept tools', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const server = fakeServer({});
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };
    expect(
      await createDefinitionTool(deps).execute({ path: file, line: 1, character: 1 }, ctx, opts),
    ).toContain('does not support definition');
    expect(
      await createCompletionTool(deps).execute({ path: file, line: 1, character: 1 }, ctx, opts),
    ).toContain('does not support completion');
    expect(
      await createDiagnosticsTool(makeDeps(null)).execute({ path: file }, ctx, opts),
    ).toContain('LSP_SERVER_NOT_FOUND');
  });

  it('covers diagnostics workspace mode and rename no-edit edge cases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const uri = pathToUri(file);
    const server = fakeServer({
      capabilities: {
        diagnosticProvider: {},
        renameProvider: true,
      },
      pullDiagnostics: vi.fn(async () => [{ range: r(0, 0), severity: 1, message: 'pulled' }]),
      getDiagnostics: vi.fn(() => [{ range: r(0, 0), severity: 2, message: 'buffered' }]),
      rename: vi.fn(async () => null),
    });
    const deps = makeDeps(server, [{ path: file, uri }]);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };
    expect(
      await createDiagnosticsTool(deps).execute({ path: file, limit: 1 }, ctx, opts),
    ).toContain('pulled');
    server.capabilities = {};
    expect(
      await createDiagnosticsTool(deps).execute({ path: file, limit: 1 }, ctx, opts),
    ).toContain('buffered');
    server.capabilities = { diagnosticProvider: {}, renameProvider: true };
    expect(await createDiagnosticsTool(deps).execute({}, ctx, opts)).toContain('buffered');
    expect(
      await createRenameTool(deps).execute(
        { path: file, line: 1, character: 1, new_name: 'b' },
        ctx,
        opts,
      ),
    ).toBe('Rename produced no edits.');

    server.capabilities = {};
    expect(
      await createRenameTool(deps).execute(
        { path: file, line: 1, character: 1, new_name: 'b' },
        ctx,
        opts,
      ),
    ).toContain('does not support rename');

    const missingDeps = makeDeps(null, [{ path: file, uri }]);
    expect(await createDiagnosticsTool(missingDeps).execute({}, ctx, opts)).toBe(
      'No LSP diagnostics.',
    );
  });

  it('uses provided unsaved content for completion requests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-completion-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const saved = 1;');
    const content = 'const unsaved = 1;\nuns';
    const server = fakeServer({
      capabilities: { completionProvider: {} },
      completion: vi.fn(async () => [
        { label: 'unsaved', kind: 6, detail: 'const unsaved: number' },
        { label: 'plain' },
      ]),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };

    const output = await createCompletionTool(deps).execute(
      { path: file, line: 2, character: 4, content, limit: 5, format: 'json' },
      ctx,
      opts,
    );
    const parsed = JSON.parse(String(output)) as {
      items: Array<{ label: string; insertText: string; kind: string; detail: string }>;
    };

    expect(deps.tracker.open).toHaveBeenCalledWith(file, content);
    expect(server.completion).toHaveBeenCalledWith(
      expect.objectContaining({
        textDocument: { uri: pathToUri(file) },
        position: { line: 1, character: 3 },
      }),
      expect.any(Number),
      opts.signal,
    );
    expect(parsed.items[0]).toMatchObject({
      label: 'unsaved',
      insertText: 'unsaved',
      kind: 'Variable',
      detail: 'const unsaved: number',
    });
  });

  it('reads saved content and formats triggered completion lists as text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-completion-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'object.');
    const server = fakeServer({
      capabilities: { completionProvider: { triggerCharacters: ['.'] } },
      completion: vi.fn(async () => ({
        isIncomplete: true,
        items: [{ label: 'property' }],
      })),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;
    const opts = { signal: new AbortController().signal };

    const output = await createCompletionTool(deps).execute(
      { path: file, line: 1, character: 8, trigger_character: '.' },
      ctx,
      opts,
    );

    expect(output).toContain('property');
    expect(server.completion).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { triggerKind: 2, triggerCharacter: '.' },
      }),
      expect.any(Number),
      opts.signal,
    );
  });

  it('rolls back failed workspace edits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tools-'));
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'const a = 1;');
    const missing = path.join(root, 'missing.ts');
    await expect(
      applyWorkspaceEdit(
        {
          changes: {
            [pathToUri(file)]: [{ range: r(0, 0), newText: 'let' }],
            [pathToUri(missing)]: [{ range: r(0, 0), newText: 'x' }],
          },
        },
        { fileWritten: vi.fn() } as never,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(file, 'utf8')).toBe('const a = 1;');
    await applyWorkspaceEdit(
      {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 99, character: 0 }, end: { line: 99, character: 0 } },
              newText: '!',
            },
          ],
        },
      },
      { fileWritten: vi.fn(async () => undefined) } as never,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('!const a = 1;');
  });

  it('safely executes tools without opts and falls back to ctx.signal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-no-opts-'));
    const file = path.join(root, 'test.ts');
    await fs.writeFile(file, 'const a = 1;');

    const server = fakeServer({
      capabilities: {
        completionProvider: {},
        definitionProvider: true,
        renameProvider: true,
      },
      completion: vi.fn(async () => ({ items: [{ label: 'test' }] })),
      definition: vi.fn(async () => null),
      rename: vi.fn(async () => null),
      pullDiagnostics: vi.fn(async () => []),
      getDiagnostics: vi.fn(() => []),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root, projectRoot: root } as never;

    const compRes = await createCompletionTool(deps).execute(
      { path: file, line: 1, character: 1 },
      ctx,
    );
    expect(String(compRes)).not.toContain('Cannot read properties of undefined');

    const defRes = await createDefinitionTool(deps).execute(
      { path: file, line: 1, character: 1 },
      ctx,
    );
    expect(String(defRes)).not.toContain('Cannot read properties of undefined');

    const diagRes = await createDiagnosticsTool(deps).execute({ path: file }, ctx);
    expect(String(diagRes)).not.toContain('Cannot read properties of undefined');

    const renameRes = await createRenameTool(deps).execute(
      { path: file, line: 1, character: 1, new_name: 'b' },
      ctx,
    );
    expect(String(renameRes)).not.toContain('Cannot read properties of undefined');
  });
});

function makeDeps(
  server: unknown,
  docs: Array<{ path: string; uri: string }> = [],
): ToolDeps & {
  tracker: {
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    fileWritten: ReturnType<typeof vi.fn>;
  };
} {
  const tracker = {
    get: vi.fn(() => null),
    list: vi.fn(() => docs),
    open: vi.fn(async () => undefined),
    fileWritten: vi.fn(async () => undefined),
  };
  return {
    registry: {
      findForPath: vi.fn(async () => server),
      list: vi.fn(() => (Array.isArray(server) ? server : server ? [server] : [])),
    },
    tracker,
    cfg,
    log: {},
  } as unknown as ToolDeps & { tracker: typeof tracker };
}

function fakeServer(overrides: Record<string, unknown>) {
  return {
    name: 'fake',
    state: 'ready',
    capabilities: {},
    completion: vi.fn(),
    definition: vi.fn(),
    rename: vi.fn(),
    pullDiagnostics: vi.fn(),
    getDiagnostics: vi.fn(() => []),
    ...overrides,
  };
}

function r(line: number, character: number) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}
