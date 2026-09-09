import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeActionsCoverage, createCodeActionsTool } from '../../src/tools/code-actions.js';
import { createExecuteCommandTool } from '../../src/tools/execute-command.js';
import { createHoverTool, hoverCoverage } from '../../src/tools/hover.js';
import { createReferencesTool } from '../../src/tools/references.js';
import { createRequestTool } from '../../src/tools/request.js';
import type { ToolDeps } from '../../src/tools/shared.js';
import { createSymbolsTool, symbolsCoverage } from '../../src/tools/symbols.js';
import type { PlugLSPConfig } from '../../src/types.js';
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

const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-guards-'));
  directories.push(root);
  const file = path.join(root, 'a.ts');
  await fs.writeFile(file, 'const a = 1;\nconst b = a;');
  return { root, file };
}

function makeDeps(server: unknown): ToolDeps {
  return {
    registry: { findForPath: vi.fn(async () => server) },
    tracker: { get: vi.fn(() => null), open: vi.fn(async () => undefined) },
    cfg,
    log: {},
  } as unknown as ToolDeps;
}

function fakeServer(overrides: Record<string, unknown> = {}) {
  return {
    name: 'fake',
    state: 'ready',
    capabilities: {} as Record<string, unknown> | undefined,
    hover: vi.fn(async () => null),
    references: vi.fn(async () => null),
    documentSymbol: vi.fn(async () => null),
    codeAction: vi.fn(async () => []),
    executeCommand: vi.fn(async () => undefined),
    customRequest: vi.fn(async () => undefined),
    waitForDiagnostics: vi.fn(async () => []),
    ...overrides,
  };
}

const opts = () => ({ signal: new AbortController().signal });

describe('tool capability guards', () => {
  it('refuses hover on a server that advertises no hover support', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({ capabilities: { renameProvider: true } });
    const out = await createHoverTool(makeDeps(server)).execute(
      { path: file, line: 1, character: 7 },
      { cwd: root } as never,
      opts(),
    );
    expect(out).toContain('LSP_CAPABILITY_MISSING');
    expect(out).toContain('does not support hover');
    expect(server.hover).not.toHaveBeenCalled();
  });

  it('runs hover when the capability is advertised and when capabilities are unknown', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { hoverProvider: true },
      hover: vi.fn(async () => ({ contents: { kind: 'markdown', value: 'const a: 1' } })),
    });
    const ctx = { cwd: root } as never;

    expect(
      await createHoverTool(makeDeps(server)).execute(
        { path: file, line: 1, character: 7 },
        ctx,
        opts(),
      ),
    ).toBe('const a: 1');
    expect(server.hover).toHaveBeenCalledWith(
      { textDocument: { uri: pathToUri(file) }, position: { line: 0, character: 6 } },
      expect.any(Number),
      expect.anything(),
    );

    // A server that has not answered `initialize` yet has no capabilities: the
    // guard must let the request through rather than invent a refusal.
    server.capabilities = undefined;
    expect(
      await createHoverTool(makeDeps(server)).execute(
        { path: file, line: 1, character: 7 },
        ctx,
        opts(),
      ),
    ).toBe('const a: 1');
  });

  it('reports hover failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { hoverProvider: true },
      hover: vi.fn(async () => {
        throw new Error('transport closed');
      }),
    });
    expect(
      await createHoverTool(makeDeps(server)).execute(
        { path: file, line: 1, character: 7 },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('transport closed');
  });

  it('refuses references on a server that advertises no references support', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({ capabilities: { hoverProvider: true } });
    const out = await createReferencesTool(makeDeps(server)).execute(
      { path: file, line: 1, character: 7 },
      { cwd: root } as never,
      opts(),
    );
    expect(out).toContain('does not support references');
    expect(server.references).not.toHaveBeenCalled();
  });

  it('passes the declaration flag through and formats reference locations', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { referencesProvider: true },
      references: vi.fn(async () => [
        {
          uri: pathToUri(file),
          range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } },
        },
      ]),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;

    expect(
      await createReferencesTool(deps).execute({ path: file, line: 1, character: 7 }, ctx, opts()),
    ).toBe('a.ts:2:11');
    expect(server.references).toHaveBeenCalledWith(
      expect.objectContaining({ context: { includeDeclaration: true } }),
      expect.any(Number),
      expect.anything(),
    );

    await createReferencesTool(deps).execute(
      { path: file, line: 1, character: 7, include_declaration: false },
      ctx,
      opts(),
    );
    expect(server.references).toHaveBeenLastCalledWith(
      expect.objectContaining({ context: { includeDeclaration: false } }),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('reports reference failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { referencesProvider: true },
      references: vi.fn(async () => {
        throw new Error('references crashed');
      }),
    });
    expect(
      await createReferencesTool(makeDeps(server)).execute(
        { path: file, line: 1, character: 7 },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('references crashed');
  });

  it('refuses document symbols on a server that advertises no symbol support', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({ capabilities: { hoverProvider: true } });
    const out = await createSymbolsTool(makeDeps(server)).execute(
      { path: file },
      { cwd: root } as never,
      opts(),
    );
    expect(out).toContain('does not support document symbols');
    expect(server.documentSymbol).not.toHaveBeenCalled();
  });

  it('renders both DocumentSymbol trees and flat SymbolInformation lists', async () => {
    const { root, file } = await fixture();
    const nested = {
      name: 'Outer',
      kind: 5,
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      children: [
        {
          name: 'inner',
          kind: 12,
          selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
        },
      ],
    };
    const server = fakeServer({
      capabilities: { documentSymbolProvider: true },
      documentSymbol: vi.fn(async () => [nested]),
    });
    expect(
      await createSymbolsTool(makeDeps(server)).execute(
        { path: file },
        { cwd: root } as never,
        opts(),
      ),
    ).toBe('Outer [5] line 1\n  inner [12] line 2');

    // The other half of the union: servers still answering with the flat
    // SymbolInformation shape carry the position under `location.range`.
    expect(
      symbolsCoverage.formatSymbols([
        {
          name: 'flat',
          kind: 13,
          location: {
            uri: pathToUri(file),
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 4 } },
          },
        },
      ] as never),
    ).toBe('flat [13] line 5');
  });

  it('reports document symbol failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { documentSymbolProvider: true },
      documentSymbol: vi.fn(async () => {
        throw new Error('symbols crashed');
      }),
    });
    expect(
      await createSymbolsTool(makeDeps(server)).execute(
        { path: file },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('symbols crashed');
  });

  it('refuses code actions on a server that advertises no code-action support', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({ capabilities: { hoverProvider: true } });
    const out = await createCodeActionsTool(makeDeps(server)).execute(
      { path: file },
      { cwd: root } as never,
      opts(),
    );
    expect(out).toContain('does not support code actions');
    expect(server.codeAction).not.toHaveBeenCalled();
  });

  it('defaults the code-action range to the file start and forwards diagnostics', async () => {
    const { root, file } = await fixture();
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: 'boom',
    };
    const server = fakeServer({
      capabilities: { codeActionProvider: true },
      waitForDiagnostics: vi.fn(async () => [diagnostic]),
      codeAction: vi.fn(async () => [{ title: 'Fix it', kind: 'quickfix' }]),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;

    expect(await createCodeActionsTool(deps).execute({ path: file }, ctx, opts())).toBe(
      '1. Fix it [quickfix]',
    );
    expect(server.codeAction).toHaveBeenCalledWith(
      {
        textDocument: { uri: pathToUri(file) },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: [diagnostic] },
      },
      expect.any(Number),
      expect.anything(),
    );

    await createCodeActionsTool(deps).execute({ path: file, line: 3, character: 5 }, ctx, opts());
    expect(server.codeAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
      }),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('reports code-action failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { codeActionProvider: true },
      codeAction: vi.fn(async () => {
        throw new Error('code actions crashed');
      }),
    });
    expect(
      await createCodeActionsTool(makeDeps(server)).execute(
        { path: file },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('code actions crashed');
  });

  it('refuses a command the server does not expose', async () => {
    const { root, file } = await fixture();
    const ctx = { cwd: root } as never;

    // No executeCommandProvider at all.
    expect(
      await createExecuteCommandTool(makeDeps(fakeServer())).execute(
        { path: file, command: '_typescript.organizeImports' },
        ctx,
        opts(),
      ),
    ).toContain('does not expose command "_typescript.organizeImports"');

    // Provider present, but this command is not in its list.
    const server = fakeServer({
      capabilities: { executeCommandProvider: { commands: ['other.command'] } },
    });
    const out = await createExecuteCommandTool(makeDeps(server)).execute(
      { path: file, command: '_typescript.organizeImports' },
      ctx,
      opts(),
    );
    expect(out).toContain('LSP_CAPABILITY_MISSING');
    expect(server.executeCommand).not.toHaveBeenCalled();
  });

  it('executes an exposed command with and without arguments', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { executeCommandProvider: { commands: ['do.thing'] } },
      executeCommand: vi.fn(async () => null),
    });
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;

    expect(
      await createExecuteCommandTool(deps).execute(
        { path: file, command: 'do.thing' },
        ctx,
        opts(),
      ),
    ).toBe('Command completed.');
    expect(server.executeCommand).toHaveBeenCalledWith(
      { command: 'do.thing' },
      expect.any(Number),
      expect.anything(),
    );

    server.executeCommand.mockResolvedValueOnce({ applied: true } as never);
    expect(
      await createExecuteCommandTool(deps).execute(
        { path: file, command: 'do.thing', arguments: [1, 'two'] },
        ctx,
        opts(),
      ),
    ).toBe(JSON.stringify({ applied: true }, null, 2));
    expect(server.executeCommand).toHaveBeenLastCalledWith(
      { command: 'do.thing', arguments: [1, 'two'] },
      expect.any(Number),
      expect.anything(),
    );
  });

  it('reports execute-command failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      capabilities: { executeCommandProvider: { commands: ['do.thing'] } },
      executeCommand: vi.fn(async () => {
        throw new Error('command crashed');
      }),
    });
    expect(
      await createExecuteCommandTool(makeDeps(server)).execute(
        { path: file, command: 'do.thing' },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('command crashed');
  });

  it('blocks lifecycle methods and empty methods from lsp_request', async () => {
    const { root, file } = await fixture();
    const server = fakeServer();
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;

    for (const method of ['initialize', 'initialized', 'shutdown', 'exit']) {
      const out = await createRequestTool(deps).execute({ path: file, method }, ctx, opts());
      expect(out).toContain('LSP_INVALID_REQUEST');
      expect(out).toContain(`"${method}" cannot be invoked`);
    }

    expect(
      await createRequestTool(deps).execute({ path: file, method: '   ' }, ctx, opts()),
    ).toContain('"(empty)" cannot be invoked');
    expect(server.customRequest).not.toHaveBeenCalled();
  });

  it('forwards a custom request with defaulted params and serializes its result', async () => {
    const { root, file } = await fixture();
    const server = fakeServer();
    const deps = makeDeps(server);
    const ctx = { cwd: root } as never;

    expect(
      await createRequestTool(deps).execute({ path: file, method: '  vendor/ping  ' }, ctx, opts()),
    ).toBe('Request completed.');
    expect(server.customRequest).toHaveBeenCalledWith(
      'vendor/ping',
      null,
      expect.any(Number),
      expect.anything(),
    );

    server.customRequest.mockResolvedValueOnce({ pong: true } as never);
    expect(
      await createRequestTool(deps).execute(
        { path: file, method: 'vendor/ping', params: { id: 1 } },
        ctx,
        opts(),
      ),
    ).toBe(JSON.stringify({ pong: true }, null, 2));
    expect(server.customRequest).toHaveBeenLastCalledWith(
      'vendor/ping',
      { id: 1 },
      expect.any(Number),
      expect.anything(),
    );
  });

  it('reports custom request failures instead of throwing out of the tool', async () => {
    const { root, file } = await fixture();
    const server = fakeServer({
      customRequest: vi.fn(async () => {
        throw new Error('request crashed');
      }),
    });
    expect(
      await createRequestTool(makeDeps(server)).execute(
        { path: file, method: 'vendor/ping' },
        { cwd: root } as never,
        opts(),
      ),
    ).toContain('request crashed');
  });

  it('renders every hover content shape servers are allowed to return', () => {
    const { formatHover } = hoverCoverage;
    expect(formatHover(null)).toBe('No hover information.');
    expect(formatHover({ contents: 'plain string' } as never)).toBe('plain string');
    expect(formatHover({ contents: { kind: 'markdown', value: '# md' } } as never)).toBe('# md');
    // Deprecated MarkedString: a language tag plus a value, rendered as a fence.
    expect(formatHover({ contents: { language: 'ts', value: 'const a: 1' } } as never)).toBe(
      '```ts\nconst a: 1\n```',
    );
    expect(
      formatHover({
        contents: ['first', { kind: 'plaintext', value: 'second' }],
      } as never),
    ).toBe('first\n\nsecond');
  });

  it('renders code actions with and without a kind or disabled reason', () => {
    const { formatActions } = codeActionsCoverage;
    expect(formatActions([])).toBe('No code actions.');
    expect(
      formatActions([
        { title: 'Bare command', command: 'do.thing' },
        { title: 'Quick fix', kind: 'quickfix' },
        { title: 'Blocked', kind: 'refactor', disabled: { reason: 'not applicable here' } },
      ] as never),
    ).toBe(
      '1. Bare command\n2. Quick fix [quickfix]\n3. Blocked [refactor] (disabled: not applicable here)',
    );
  });

  it('falls back to ctx.signal when a tool is called without opts', async () => {
    const { root, file } = await fixture();
    const signal = new AbortController().signal;
    const ctx = { cwd: root, signal } as never;
    const server = fakeServer({
      capabilities: {
        hoverProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        codeActionProvider: true,
        executeCommandProvider: { commands: ['do.thing'] },
      },
    });
    const deps = makeDeps(server);

    await createHoverTool(deps).execute(
      { path: file, line: 1, character: 1 },
      ctx,
      undefined as never,
    );
    await createReferencesTool(deps).execute(
      { path: file, line: 1, character: 1 },
      ctx,
      undefined as never,
    );
    await createSymbolsTool(deps).execute({ path: file }, ctx, undefined as never);
    await createCodeActionsTool(deps).execute({ path: file }, ctx, undefined as never);
    await createExecuteCommandTool(deps).execute(
      { path: file, command: 'do.thing' },
      ctx,
      undefined as never,
    );
    await createRequestTool(deps).execute(
      { path: file, method: 'vendor/ping' },
      ctx,
      undefined as never,
    );

    for (const mock of [
      server.hover,
      server.references,
      server.documentSymbol,
      server.codeAction,
      server.executeCommand,
      server.customRequest,
    ]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]!.at(-1)).toBe(signal);
    }
  });
});
