import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { createHttpServer } from '../src/index.js';

// Security scan 2026-08-04, finding H3: the HTTP API now requires a token on
// every bind, including loopback. These suites previously exercised the
// unauthenticated configuration that finding was about.
const TEST_API_TOKEN = 'test-api-token';
const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), 'x-ws-token': TEST_API_TOKEN },
  });

const mockRunDeadCodeScan = vi.fn();

interface ErrorResponse {
  error: string;
}

interface DeadCodeActionPlanResponse {
  totalDeadSymbols: number;
  totalDeadFiles: number;
  totalDeadPackages: number;
  files: Array<{ priority: number; file: string }>;
}

vi.mock('@wrongstack/tools/codebase-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/tools/codebase-index')>();
  return {
    ...actual,
    runDeadCodeScan: (...args: any[]) => mockRunDeadCodeScan(...args),
  };
});

describe('Dead-Code Scan Endpoints', () => {
  let distDir: string;
  let server: http.Server;
  let baseUrl: string;
  const projectRoot = path.join(os.tmpdir(), 'deadcode-test-proj');

  beforeAll(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-deadcode-'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>root</title>');
    await fs.mkdir(projectRoot, { recursive: true });

    server = createHttpServer({
      host: '127.0.0.1',
      distDir,
      projectRoot,
      apiToken: TEST_API_TOKEN,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('POST /api/deadcode/scan runs codebase index scan', async () => {
    const dummyResult = {
      deadSymbols: [{ name: 'foo', kind: 'function', line: 10, file: 'src/foo.ts' }],
      deadFiles: [{ file: 'src/bar.ts', symbolCount: 5 }],
      deadPackages: [{ package: 'pkg-a', fileCount: 3, path: 'packages/pkg-a' }],
      entryPoints: ['src/index.ts'],
      stats: { totalSymbols: 20, alive: 14, dead: 6, durationMs: 42 },
    };
    mockRunDeadCodeScan.mockReturnValue(dummyResult);

    const res = await authFetch(`${baseUrl}/api/deadcode/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexDir: '.wstack-index',
        entryPoints: ['src/index.ts'],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(dummyResult);
    expect(mockRunDeadCodeScan).toHaveBeenCalledWith(projectRoot, {
      indexDir: '.wstack-index',
      userEntryPoints: ['src/index.ts'],
    });
  });

  it('POST /api/deadcode/scan rejects path traversal indexDir', async () => {
    const res = await authFetch(`${baseUrl}/api/deadcode/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indexDir: '../../etc',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toContain('Invalid indexDir');
  });

  it('POST /api/deadcode/action-plan generates sorted plan', async () => {
    const scanOutput = {
      deadSymbols: [{ name: 'funcA', kind: 'function', line: 15, file: 'src/alive.ts' }],
      deadFiles: [{ file: 'src/dead-file.ts', symbolCount: 2 }],
      deadPackages: [{ package: 'pkg-dead', fileCount: 4, path: 'packages/pkg-dead' }],
      entryPoints: ['src/index.ts'],
      stats: { totalSymbols: 20, alive: 13, dead: 7, durationMs: 12 },
    };

    const res = await authFetch(`${baseUrl}/api/deadcode/action-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scanOutput),
    });

    expect(res.status).toBe(200);
    const plan = (await res.json()) as DeadCodeActionPlanResponse;
    expect(plan.totalDeadSymbols).toBe(7);
    expect(plan.totalDeadFiles).toBe(1);
    expect(plan.totalDeadPackages).toBe(1);
    expect(plan.files).toHaveLength(3);
    const [deadPackage, deadFile, aliveFile] = plan.files;
    if (!deadPackage || !deadFile || !aliveFile) {
      throw new Error('Expected package, dead-file, and symbol action-plan entries');
    }

    // Assert priority sorting: pkg-dead (0) -> src/dead-file.ts (1) -> src/alive.ts (2)
    expect(deadPackage.priority).toBe(0);
    expect(deadPackage.file).toContain('pkg-dead');
    expect(deadFile.priority).toBe(1);
    expect(deadFile.file).toBe('src/dead-file.ts');
    expect(aliveFile.priority).toBe(2);
    expect(aliveFile.file).toBe('src/alive.ts');
  });
});
