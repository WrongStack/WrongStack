/**
 * WrongMemoryPort against the real `wrongmemoryd` (temp data root, managed
 * project in a temp dir). Point WRONGMEMORYD_PATH at a built daemon, or build
 * the WrongMemory checkout next to this repo (`cargo build -p wrongmemoryd`).
 * Skipped when no daemon binary is available.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WrongMemoryClient } from '@wrongstack/wrongmemory-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSageService, getSageSurface } from '../src/memory-port.js';
import { WrongMemoryPort } from '../src/wrongmemory-port.js';

const exe = process.platform === 'win32' ? 'wrongmemoryd.exe' : 'wrongmemoryd';
const DAEMON =
  process.env.WRONGMEMORYD_PATH ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../WrongMemory/target/debug',
    exe,
  );
const available = existsSync(DAEMON);

describe.skipIf(!available)('WrongMemoryPort against a real wrongmemoryd', () => {
  let tmp: string;
  let home: string;
  let proj: string;
  let port: WrongMemoryPort;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'wm-port-'));
    home = path.join(tmp, 'home');
    proj = path.join(tmp, 'proj');
    mkdirSync(path.join(proj, 'src'), { recursive: true });
    writeFileSync(path.join(proj, 'src', 'lib.rs'), 'pub fn handler() {}');
    port = new WrongMemoryPort({
      projectRoot: proj,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'on-demand',
      timeoutMs: 15_000,
    });
    await port.initialize();
  }, 60_000);

  afterAll(async () => {
    await port?.dispose();
    try {
      const c = await WrongMemoryClient.connect({ dataRoot: home, clientName: 'stop' });
      await c.call('daemon.shutdown', {}).catch(() => undefined);
      c.close();
    } catch {
      // daemon already gone
    }
    // Give the daemon a moment to release its files before cleanup.
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 30_000);

  it('registers a managed project and reports ready', async () => {
    expect(port.getProject()).toMatchObject({ storeKind: 'managed', admission: 'read-write' });
    expect((await port.health()).status).toBe('ready');
  });

  it('remember -> search -> update with expectedRevision conflict', async () => {
    const service = getSageService(port)!;
    const created = await service.rememberSage({
      text: 'The request handler validates the auth header before routing',
      kind: 'convention',
      anchors: [{ type: 'file', path: 'src/lib.rs' }],
    });
    expect(created.revision).toBe(1);

    const hits = await service.searchSage('auth header handler');
    expect(hits.map((h) => h.id)).toContain(created.id);

    const updated = await service.updateSage(created.id, { importance: 0.9, expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    expect(updated.importance).toBeCloseTo(0.9);
    await expect(
      service.updateSage(created.id, { importance: 0.1, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await service.getSage(created.id))?.revision).toBe(2);
    expect(await service.getSage('mem_does_not_exist')).toBeNull();
  });

  it('createCandidate -> acceptCandidate -> retrieveForPath', async () => {
    const surface = getSageSurface(port)!;
    const candidate = await surface.createCandidate({
      text: 'Integration tests spawn the real daemon binary from target/debug',
      anchors: [{ type: 'file', path: 'src/lib.rs' }],
    });
    expect(candidate.status).toBe('pending');
    expect((await surface.listCandidates()).map((c) => c.id)).toContain(candidate.id);

    const accepted = await surface.acceptCandidate(candidate.id);
    expect(accepted?.text).toContain('real daemon binary');
    expect(await surface.listCandidates()).toEqual([]);

    const forPath = await surface.retrieveForPath({ path: 'src/lib.rs' });
    expect(forPath.map((m) => m.id)).toContain(accepted!.id);

    const stats = await surface.stats();
    expect(stats.byStatus.active).toBeGreaterThanOrEqual(2);
  });

  it('retrieveForAudience matches roles case-insensitively and reports truncation', async () => {
    const service = getSageService(port)!;
    const surface = getSageSurface(port)!;
    const reviewer = await service.rememberSage({
      text: 'Reviewers check that every migration has a rollback script',
      kind: 'role_operational',
      importance: 0.9,
      audience: { roles: ['Reviewer'] },
    });
    await service.rememberSage({
      text: 'Coders regenerate the protobuf bindings after schema edits',
      kind: 'convention',
      importance: 0.8,
      audience: { roles: ['coder'] },
    });
    const hits = await surface.retrieveForAudience({ role: 'REVIEWER' });
    expect(hits.map((m) => m.id)).toEqual([reviewer.id]);
    expect(await surface.retrieveForAudience({ role: 'nobody' }, 5)).toEqual([]);

    const truncated: Array<{ sqlRowsExamined: number; returned: number }> = [];
    const one = await surface.retrieveForAudience({ role: 'coder' }, 1, (info) =>
      truncated.push(info),
    );
    expect(one).toHaveLength(1);
    expect(truncated).toEqual([]);
  });

  it('legacy forget / consolidate / clear run on the daemon', async () => {
    await port.remember('Nightly builds publish to the staging bucket', 'user-memory');
    expect(await port.forget('STAGING BUCKET', 'user-memory')).toBe(1);
    expect(await port.forget('   ', 'user-memory')).toBe(0);
    await port.consolidate('user-memory');
    await port.remember('Lint runs before every push', 'user-memory');
    await port.clear('user-memory');
    expect(await port.list('user-memory')).toEqual([]);
  });

  it('serves legacy MemoryStore reads from SAGE', async () => {
    await port.remember('Release builds use cargo build --locked', 'project-memory', {
      type: 'convention',
    });
    const entries = await port.list('project-memory');
    expect(entries.map((e) => e.text)).toContain('Release builds use cargo build --locked');
    expect(await port.readAll()).toContain('cargo build --locked');
  });
});
