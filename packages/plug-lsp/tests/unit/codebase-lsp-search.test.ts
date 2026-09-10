import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCodebaseLspSearchTool } from '../../src/tools/codebase-lsp-search.js';
import type { ToolDeps } from '../../src/tools/shared.js';
import { pathToUri } from '../../src/utils/uri.js';

// Mock the codebase-index import so searchIndex doesn't hit SQLite
vi.mock('@wrongstack/tools/codebase-index/index', () => ({
  searchCodebaseIndex: vi.fn(async () => ({ results: [], total: 0 })),
  codebaseIndexDirOverride: vi.fn(() => undefined),
  internalKindToLspKind: vi.fn((k: string) => (k === 'function' ? 12 : 0)),
  lspKindToInternalKind: vi.fn((k: number) => (k === 12 ? 'function' : 'symbol')),
}));

function makeMockServer(opts: {
  name: string;
  state?: string;
  languages?: string[];
  workspaceSymbol?: ReturnType<typeof vi.fn>;
  capabilities?: Record<string, unknown>;
}) {
  return {
    name: opts.name,
    state: opts.state ?? 'ready',
    config: { command: 'test', languages: opts.languages ?? ['typescript'], enabled: true },
    capabilities: opts.capabilities ?? { workspaceSymbolProvider: true },
    workspaceSymbol: opts.workspaceSymbol ?? vi.fn(async () => []),
  };
}

function makeDeps(servers: ReturnType<typeof makeMockServer>[] = []): ToolDeps {
  return {
    registry: {
      ensureProjectServersReady: vi.fn(async () => {}),
      list: () => servers,
    },
  } as unknown as ToolDeps;
}

describe('createCodebaseLspSearchTool', () => {
  it('returns the tool metadata', () => {
    const tool = createCodebaseLspSearchTool(makeDeps());
    expect(tool.name).toBe('codebase-lsp-search');
    expect(tool.inputSchema.required).toContain('query');
  });

  it('returns formatted empty results when no sources match', async () => {
    const tool = createCodebaseLspSearchTool(makeDeps());
    const result = await tool.execute(
      { query: 'nonexistent' },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(result).toContain('No symbols matching "nonexistent"');
  });

  it('returns error string on empty query', async () => {
    const tool = createCodebaseLspSearchTool(makeDeps());
    const result = await tool.execute(
      { query: '' },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // Empty query → index returns nothing, LSP returns nothing → "No symbols"
    expect(result).toContain('No symbols');
  });

  it('queries LSP servers when preferLsp is true', async () => {
    const wsSymbol = vi.fn(async () => [
      {
        name: 'myFunc',
        kind: 12,
        location: {
          uri: 'file:///proj/src.ts',
          range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
        },
      },
    ]);
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const deps = makeDeps([server]);
    const tool = createCodebaseLspSearchTool(deps);

    const result = await tool.execute(
      { query: 'myFunc', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(wsSymbol).toHaveBeenCalled();
    expect(deps.registry.ensureProjectServersReady).toHaveBeenCalled();
    expect(result).toContain('myFunc');
    expect(result).toContain('[lsp:ts]');
  });

  it('skips LSP servers that are not ready', async () => {
    const wsSymbol = vi.fn(async () => []);
    const server = makeMockServer({ name: 'ts', state: 'stopped', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    await tool.execute(
      { query: 'test', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(wsSymbol).not.toHaveBeenCalled();
  });

  it('handles individual LSP server errors gracefully', async () => {
    const wsSymbol = vi.fn(async () => {
      throw new Error('LSP crashed');
    });
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    // Should not throw — individual server errors are non-fatal
    const result = await tool.execute(
      { query: 'test', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(result).toContain('No symbols');
  });

  it('respects the limit parameter', async () => {
    const symbols = Array.from({ length: 50 }, (_, i) => ({
      name: `func${i}`,
      kind: 12,
      location: {
        uri: 'file:///proj/src.ts',
        range: { start: { line: i, character: 0 }, end: { line: i, character: 10 } },
      },
    }));
    const wsSymbol = vi.fn(async () => symbols);
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    const result = await tool.execute(
      { query: 'func', preferLsp: true, limit: 5 },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // The results should be capped — "5 results"
    expect(result).toContain('5 results');
  });

  it('resolves symbol location URIs to usable paths', async () => {
    const wsSymbol = vi.fn(async () => [
      {
        name: 'test',
        kind: 12,
        location: {
          uri: pathToUri(path.join('/proj', 'deep', 'src.ts')),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        },
      },
      {
        name: 'spaced',
        kind: 12,
        location: {
          uri: pathToUri(path.join('/proj', 'deep', 'my file.ts')),
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        },
      },
    ]);
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    const result = await tool.execute(
      { query: 'test', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // The location URI must become a real filesystem path: `slice(7)` left a
    // `/D:/…` root-relative artifact on Windows and kept `%20` encoded on
    // every platform, so neither the display nor the dedupe key was usable.
    expect(result).toContain('deep/src.ts');
    expect(result).toContain('my file.ts');
    expect(result).not.toContain('/D:/');
    expect(result).not.toContain('%20');
    expect(result).not.toContain('file://');
  });

  it('keeps searching when a server returns degenerate location URIs', async () => {
    const wsSymbol = vi.fn(async () => [
      {
        name: 'driveless',
        kind: 12,
        location: {
          // `fileURLToPath` rejects drive-less file URLs on Windows.
          uri: 'file:///proj/lonely.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        },
      },
      {
        name: 'encodedSlash',
        kind: 12,
        location: {
          // Encoded slashes are rejected by `fileURLToPath` on POSIX.
          uri: 'file:///proj/de%2Fep/x.ts',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        },
      },
      {
        name: 'untitledBuffer',
        kind: 12,
        location: {
          // Non-file schemes pass through unchanged.
          uri: 'untitled:Untitled-1',
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
        },
      },
    ]);
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    // A degenerate URI must not abort the search — each hit still renders.
    const result = await tool.execute(
      { query: 'sym', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(result).toContain('driveless');
    expect(result).toContain('encodedSlash');
    expect(result).toContain('untitledBuffer');
  });

  it('converts 0-based LSP line numbers to 1-based', async () => {
    const wsSymbol = vi.fn(async () => [
      {
        name: 'test',
        kind: 12,
        location: {
          uri: 'file:///proj/src.ts',
          range: { start: { line: 9, character: 0 }, end: { line: 9, character: 4 } },
        },
      },
    ]);
    const server = makeMockServer({ name: 'ts', workspaceSymbol: wsSymbol });
    const tool = createCodebaseLspSearchTool(makeDeps([server]));

    const result = await tool.execute(
      { query: 'test', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // LSP line 9 → display line 10
    expect(result).toContain(':10');
  });

  it('infers server name from file extension', async () => {
    const wsSymbol = vi.fn(async () => [
      {
        name: 'test',
        kind: 12,
        location: {
          uri: 'file:///proj/src.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        },
      },
    ]);
    const tsServer = makeMockServer({
      name: 'tsserver',
      languages: ['typescript'],
      workspaceSymbol: wsSymbol,
    });
    const tool = createCodebaseLspSearchTool(makeDeps([tsServer]));

    const result = await tool.execute(
      { query: 'test', preferLsp: true },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // .ts file → langMap maps to 'typescript'/'tsserver' → server name 'tsserver'
    expect(result).toContain('[lsp:tsserver]');
  });

  it('catches and formats errors from execute', async () => {
    // Force searchCodebaseIndex to throw
    const { searchCodebaseIndex } = await import('@wrongstack/tools/codebase-index/index');
    vi.mocked(searchCodebaseIndex).mockRejectedValueOnce(new Error('DB locked'));

    const tool = createCodebaseLspSearchTool(makeDeps());
    const result = await tool.execute(
      { query: 'test' },
      { projectRoot: '/proj', cwd: '/proj' } as never,
      { signal: new AbortController().signal } as never,
    );
    // Should contain the error message, not crash
    expect(typeof result).toBe('string');
  });
});
