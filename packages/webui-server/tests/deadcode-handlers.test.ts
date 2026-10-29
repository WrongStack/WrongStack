import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/index.js';

// Security scan 2026-08-04, finding H3: the HTTP API requires a token on every
// bind, including loopback — and these routes write project files.
const TEST_API_TOKEN = 'test-api-token';
const post = (
  url: string,
  body: unknown,
  token: string | null = TEST_API_TOKEN,
): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-ws-token': token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

interface Finding {
  id: string;
  category: string;
  file: string;
  name?: string;
}

/** Real engine, real files: the panel's whole loop against a tiny project. */
describe('dead-code endpoints', () => {
  let base: string;
  let projectRoot: string;
  let server: http.Server;
  let baseUrl: string;
  let prevHome: string | undefined;

  const write = async (rel: string, text: string): Promise<void> => {
    await fs.mkdir(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    await fs.writeFile(path.join(projectRoot, rel), text);
  };
  const scan = async (): Promise<Finding[]> => {
    const res = await post(`${baseUrl}/api/deadcode/scan`, {});
    expect(res.status).toBe(200);
    return ((await res.json()) as { findings: Finding[] }).findings;
  };

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-deadcode-'));
    projectRoot = path.join(base, 'proj');
    prevHome = process.env.WRONGSTACK_HOME;
    process.env.WRONGSTACK_HOME = path.join(base, 'home');
    await write(
      'package.json',
      JSON.stringify({ name: 'app', private: true, main: 'src/main.ts' }),
    );
    await write('src/main.ts', "import { used } from './lib.js';\nused();\n");
    await write(
      'src/lib.ts',
      'export function used(): void {}\nexport function unusedFn(): void {}\n',
    );
    await write('src/orphan.ts', 'export const orphan = 1;\n');

    const distDir = path.join(base, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>root</title>');
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
    if (prevHome === undefined) delete process.env.WRONGSTACK_HOME;
    else process.env.WRONGSTACK_HOME = prevHome;
    await fs.rm(base, { recursive: true, force: true });
  });

  it('refuses token-less writes (loopback reads stay open, as for every GET route)', async () => {
    expect((await post(`${baseUrl}/api/deadcode/scan`, {}, null)).status).toBe(401);
    expect((await post(`${baseUrl}/api/deadcode/apply`, { ids: ['x'] }, null)).status).toBe(401);
    expect((await post(`${baseUrl}/api/deadcode/undo`, { backupId: 'x' }, null)).status).toBe(401);
  });

  it('rejects malformed bodies and out-of-project paths with 400', async () => {
    expect((await post(`${baseUrl}/api/deadcode/scan`, '{nope')).status).toBe(400);
    expect((await post(`${baseUrl}/api/deadcode/scan`, { paths: ['../etc'] })).status).toBe(400);
    expect((await post(`${baseUrl}/api/deadcode/preview`, { ids: [] })).status).toBe(400);
    expect((await post(`${baseUrl}/api/deadcode/apply`, { ids: 'x' })).status).toBe(400);
    expect(
      (await post(`${baseUrl}/api/deadcode/apply`, { ids: ['x'], expectedRevision: 1 })).status,
    ).toBe(400);
    expect((await post(`${baseUrl}/api/deadcode/undo`, { backupId: '../x' })).status).toBe(400);
  });

  it('scans, previews without writing, applies, and undoes', async () => {
    const findings = await scan();
    const orphan = findings.find(
      (f) => f.category === 'unreachable-file' && f.file === 'src/orphan.ts',
    );
    const dead = findings.find((f) => f.category === 'dead-export' && f.name === 'unusedFn');
    expect(orphan).toBeDefined();
    expect(dead).toBeDefined();
    const ids = [orphan!.id, dead!.id];

    const preview = await post(`${baseUrl}/api/deadcode/preview`, { ids });
    const plan = (await preview.json()) as {
      changes: Array<{ file: string; diff: string }>;
      revision: string;
    };
    expect(plan.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.changes.map((c) => c.file).sort()).toEqual(['src/lib.ts', 'src/orphan.ts']);
    expect(plan.changes.find((c) => c.file === 'src/lib.ts')?.diff).toContain(
      '-export function unusedFn',
    );
    await expect(fs.readFile(path.join(projectRoot, 'src/orphan.ts'), 'utf8')).resolves.toContain(
      'orphan',
    );

    const applied = (await (
      await post(`${baseUrl}/api/deadcode/apply`, {
        ids,
        verify: 'none',
        expectedRevision: plan.revision,
      })
    ).json()) as {
      ok: boolean;
      backupId: string;
      deleted: string[];
    };
    expect(applied.ok).toBe(true);
    expect(applied.deleted).toEqual(['src/orphan.ts']);
    await expect(fs.stat(path.join(projectRoot, 'src/orphan.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(projectRoot, 'src/lib.ts'), 'utf8')).toBe(
      'export function used(): void {}\n',
    );
    expect((await scan()).some((f) => f.id === dead!.id)).toBe(false);

    const backups = (await (
      await fetch(`${baseUrl}/api/deadcode/backups`, { headers: { 'x-ws-token': TEST_API_TOKEN } })
    ).json()) as { backups: Array<{ id: string }> };
    expect(backups.backups[0]?.id).toBe(applied.backupId);

    const undo = (await (
      await post(`${baseUrl}/api/deadcode/undo`, { backupId: applied.backupId })
    ).json()) as {
      restored: string[];
      conflicts: string[];
    };
    expect(undo.conflicts).toEqual([]);
    expect(undo.restored.sort()).toEqual(['src/lib.ts', 'src/orphan.ts']);
    expect(await fs.readFile(path.join(projectRoot, 'src/orphan.ts'), 'utf8')).toBe(
      'export const orphan = 1;\n',
    );
  });
});
