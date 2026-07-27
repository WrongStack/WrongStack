import type * as http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fileGraphService, packageGraphService, symbolGraphService } = vi.hoisted(() => ({
  packageGraphService: vi.fn(async () => ({ nodes: [{ id: 'pkg' }], edges: [] })),
  fileGraphService: vi.fn(async () => ({ nodes: [{ id: 'file' }], edges: [] })),
  symbolGraphService: vi.fn(async () => ({ nodes: [{ id: 'symbol' }], edges: [] })),
}));

vi.mock('@wrongstack/tools', () => ({
  fileGraphService,
  packageGraphService,
  symbolGraphService,
}));

vi.mock('../src/server/codemap-cache.js', () => ({
  codemapCacheKey: vi.fn((_root: string, _indexDir: string | undefined, scope: string) => scope),
  getCachedCodemapBody: vi.fn(() => undefined),
  indexDbVersion: vi.fn(() => 'present'),
  setCachedCodemapBody: vi.fn(),
}));

import {
  handleCodemapFiles,
  handleCodemapPackages,
  handleCodemapSymbols,
} from '../src/server/codemap-handlers.js';

function responseCapture(): {
  response: http.ServerResponse;
  status: () => number | undefined;
  body: () => unknown;
} {
  let responseStatus: number | undefined;
  let responseBody = '';
  return {
    response: {
      writeHead(status: number) {
        responseStatus = status;
        return this;
      },
      end(chunk?: string) {
        responseBody = chunk ?? '';
        return this;
      },
    } as never as http.ServerResponse,
    status: () => responseStatus,
    body: () => JSON.parse(responseBody),
  };
}

describe('Code Atlas graph handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes package, file, and symbol graph reads through the shared index services', async () => {
    const deps = { projectRoot: 'D:/repo', indexDir: 'D:/index' };

    const packages = responseCapture();
    await handleCodemapPackages(packages.response, deps);
    expect(packages.status()).toBe(200);
    expect(packages.body()).toMatchObject({ nodes: [{ id: 'pkg' }] });
    expect(packageGraphService).toHaveBeenCalledWith({
      projectRoot: 'D:/repo',
      indexDir: 'D:/index',
    });

    const files = responseCapture();
    await handleCodemapFiles(files.response, deps, '@wrongstack/tools');
    expect(files.status()).toBe(200);
    expect(files.body()).toMatchObject({ nodes: [{ id: 'file' }] });
    expect(fileGraphService).toHaveBeenCalledWith({
      projectRoot: 'D:/repo',
      indexDir: 'D:/index',
      packageFilter: '@wrongstack/tools',
    });

    const symbols = responseCapture();
    await handleCodemapSymbols(symbols.response, deps, 'src/index.ts');
    expect(symbols.status()).toBe(200);
    expect(symbols.body()).toMatchObject({ nodes: [{ id: 'symbol' }] });
    expect(symbolGraphService).toHaveBeenCalledWith({
      projectRoot: 'D:/repo',
      indexDir: 'D:/index',
      fileFilter: 'src/index.ts',
    });
  });

  it('returns 400 before touching the index when drill-down scope is missing', async () => {
    const files = responseCapture();
    await handleCodemapFiles(files.response, { projectRoot: 'D:/repo' }, '');
    expect(files.status()).toBe(400);
    expect(fileGraphService).not.toHaveBeenCalled();

    const symbols = responseCapture();
    await handleCodemapSymbols(symbols.response, { projectRoot: 'D:/repo' }, '');
    expect(symbols.status()).toBe(400);
    expect(symbolGraphService).not.toHaveBeenCalled();
  });
});
