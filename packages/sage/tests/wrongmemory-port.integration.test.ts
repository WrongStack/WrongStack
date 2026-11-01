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
import { METHODS, WrongMemoryClient } from '@wrongstack/wrongmemory-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectSageMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
} from '../src/memory-port.js';
import { createSagePathRemapMiddleware } from '../src/middleware/path-remap.js';
import { InvalidSearchCursorError } from '../src/service-contract.js';
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

  it('findMemoriesForFile groups file and symbol matches', async () => {
    const service = getSageService(port)!;
    const fileNote = await service.rememberSage({
      text: 'The handler module owns request routing',
      anchors: [{ type: 'file', path: 'src/lib.rs' }],
    });
    const symbolNote = await service.rememberSage({
      text: 'handler() must stay allocation free',
      kind: 'symbol_note',
      anchors: [{ type: 'symbol', path: 'src/lib.rs', symbol: 'handler' }],
    });
    const res = await service.findMemoriesForFile('src/lib.rs');
    expect(res.filePath).toBe('src/lib.rs');
    expect(res.primaryMatches.map((m) => m.memory.id)).toContain(fileNote.id);
    expect(res.symbolMatches.map((m) => [m.memory.id, m.matchedVia])).toContainEqual([
      symbolNote.id,
      'anchor_symbol',
    ]);
    await expect(service.findMemoriesForFile('../escape.rs')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('verify and verifyForPaths reconcile anchors on the daemon', async () => {
    const service = getSageService(port)!;
    writeFileSync(path.join(proj, 'src', 'gone.rs'), 'pub fn gone() {}');
    const m = await service.rememberSage({
      text: 'gone.rs holds the shutdown hook',
      anchors: [{ type: 'file', path: 'src/gone.rs' }],
    });
    const ok = await service.verify(m.id);
    expect(ok.map((r) => [r.memoryId, r.status])).toEqual([[m.id, 'verified']]);
    rmSync(path.join(proj, 'src', 'gone.rs'));
    const stale = await getSageRetrieval(port)!.verifyForPaths!(['src/gone.rs']);
    expect(stale.map((r) => [r.memoryId, r.status])).toEqual([[m.id, 'stale']]);
    expect((await service.getSage(m.id))?.status).toBe('stale');
  });

  it('importLegacy imports Markdown bullets and refuses files outside the project', async () => {
    const surface = getSageSurface(port)!;
    writeFileSync(
      path.join(proj, 'LEGACY.md'),
      '# Notes\n- Release tags follow vX.Y.Z.\n- \nprose line\n',
    );
    writeFileSync(path.join(tmp, 'outside.md'), '- outside fact\n');
    expect(await surface.importLegacy!(['LEGACY.md'])).toEqual({
      imported: 1,
      skipped: 1,
      files: 1,
    });
    const hits = await getSageService(port)!.searchSage('release tags');
    expect(hits.map((m) => m.text)).toContain('Release tags follow vX.Y.Z.');
    await expect(surface.importLegacy!(['../outside.md'])).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('rollback: project.export hands the store to local SAGE and back (WM-409/601)', async () => {
    const root = path.join(tmp, 'rollback');
    mkdirSync(root, { recursive: true });
    const remote = new WrongMemoryPort({
      projectRoot: root,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'on-demand',
      timeoutMs: 15_000,
    });
    await remote.initialize();
    const written = await getSageService(remote)!.rememberSage({
      text: 'Rollback keeps the release-tag decision',
    });
    await remote.dispose();

    const host = await WrongMemoryClient.connect({ dataRoot: home, clientName: 'rollback' });
    try {
      const { projects } = await host.call<{ projects: { projectId: string; root: string }[] }>(
        METHODS.PROJECT_LIST,
        {},
      );
      const project = projects.find((p) => path.resolve(p.root) === path.resolve(root));
      expect(project).toBeDefined();
      const exported = await host.call<{ detached: boolean; legacyStorePath: string }>(
        METHODS.PROJECT_EXPORT,
        { projectId: project!.projectId },
      );
      expect(exported.detached).toBe(true);
      expect(existsSync(path.join(root, '.wrongstack', 'memories', 'sage.db'))).toBe(true);
    } finally {
      host.close();
    }

    // Local SAGE (the in-process store under vitest) opens the exported copy.
    const local = createProjectSageMemoryPort({ projectRoot: root });
    await local.initialize?.();
    const localService = getSageService(local)!;
    expect((await localService.getSage(written.id))?.text).toBe(
      'Rollback keeps the release-tag decision',
    );
    const localWrite = await localService.rememberSage({
      text: 'Local SAGE wrote this after the rollback',
    });
    await local.dispose?.();

    // Back to WrongMemory: the root now adopts the same store, never a new
    // empty managed one, and both records are there.
    const again = new WrongMemoryPort({
      projectRoot: root,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'on-demand',
      timeoutMs: 15_000,
    });
    await again.initialize();
    try {
      const service = getSageService(again)!;
      expect((await service.getSage(written.id))?.id).toBe(written.id);
      expect((await service.getSage(localWrite.id))?.text).toBe(
        'Local SAGE wrote this after the rollback',
      );
    } finally {
      await again.dispose();
    }
  });

  it('maintenance schedule hands hygiene to the daemon scheduler (WM-404)', async () => {
    const surface = getSageSurface(port)!;
    const before = await surface.maintenance!('status');
    expect(before.owner).toBe('daemon');
    const status = await surface.maintenance!('schedule', {
      retentionDays: 30,
      bogus: 1,
    } as never);
    expect(status.owner).toBe('daemon');
    expect(status.scheduled).toBe(true);
    expect(status.intervalMs).toBeGreaterThan(0);
    expect(typeof status.nextRunAt).toBe('string');
  });

  it('path-remap hook moves anchors through the daemon after a git mv (WM-404)', async () => {
    const service = getSageService(port)!;
    const note = await service.rememberSage({
      text: 'remap-source holds the retry policy',
      anchors: [{ type: 'file', path: 'src/remap-source.rs' }],
    });
    const mw = createSagePathRemapMiddleware({ memory: port, maxPerHour: 50 });
    await mw.handler(
      {
        toolUse: {
          id: 't',
          name: 'bash',
          input: { command: 'git mv src/remap-source.rs src/remap-target.rs' },
        },
        result: { content: '', is_error: false },
        ctx: { projectRoot: proj, cwd: proj },
      } as never,
      async (p) => p,
    );
    const after = await service.getSage(note.id);
    expect(after?.anchors?.map((a) => a.path)).toEqual(['src/remap-target.rs']);
    expect(after?.revision).toBeGreaterThan(note.revision ?? 0);
  });

  it('doctor and readAudit run on the daemon (WM-406)', async () => {
    const surface = getSageSurface(port)!;
    const report = await surface.doctor!();
    expect(report.checks.map((c) => c.id)).toContain('fts-integrity');
    expect(report.maintenance?.owner).toBe('daemon');
    const fixed = await surface.doctor!({ fix: ['fts-rebuild'] });
    expect(fixed.fixesApplied?.[0]).toMatchObject({ fix: 'fts-rebuild', changed: 1 });
    const audit = await surface.readAudit!(1);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event).toBe('memory.doctor_fix');
  });

  it('emits the in-process store events after its own mutations (WM-406)', async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const evPort = new WrongMemoryPort({
      projectRoot: proj,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'never',
      timeoutMs: 15_000,
      getSessionId: () => 'ev-session',
      events: { emit: (e, p) => seen.push([e, p as Record<string, unknown>]) },
    });
    await evPort.initialize();
    try {
      const svc = getSageService(evPort)!;
      const m = await svc.rememberSage({ text: 'Event relay: lockfiles are committed' });
      const again = await svc.rememberSage({ text: 'Event relay: lockfiles are committed' });
      expect(again.id).toBe(m.id);
      await svc.updateSage(m.id, { importance: 0.9 });
      await svc.deleteSage(m.id, 'obsolete', { force: true });
      await svc.recoverSage(m.id, 'restored');
      expect(seen.map(([e]) => e)).toEqual([
        'memory.accepted',
        'memory.merged',
        'memory.updated',
        'memory.deleted',
        'memory.updated',
        'memory.recovered',
      ]);
      expect(seen[0]?.[1]).toMatchObject({ memoryId: m.id, sessionId: 'ev-session' });
      expect(seen[3]?.[1]).toMatchObject({ memoryId: m.id, reason: 'obsolete' });
      expect(seen[4]?.[1]).toMatchObject({ memoryId: m.id, status: 'deleted' });
    } finally {
      await evPort.dispose();
    }
  });

  it('relays changes committed through other connections (WM-406)', async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const watcher = new WrongMemoryPort({
      projectRoot: proj,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'never',
      timeoutMs: 15_000,
      relayIntervalMs: 0,
      events: { emit: (e, p) => seen.push([e, p as Record<string, unknown>]) },
    });
    await watcher.initialize();
    try {
      await watcher.relayChanges();
      const own = await getSageService(watcher)!.rememberSage({
        text: 'Relay: watcher wrote this',
      });
      const other = await getSageService(port)!.rememberSage({
        text: 'Relay: another host wrote this',
      });
      seen.length = 0;
      await watcher.relayChanges();
      const relayed = seen.filter(([, p]) => p.remote === true).map(([e, p]) => [e, p.memoryId]);
      expect(relayed).toEqual([['memory.accepted', other.id]]);
      expect(relayed.some(([, id]) => id === own.id)).toBe(false);
    } finally {
      await watcher.dispose();
    }
  });

  it('unifiedSearchService walks keyset cursors on the daemon', async () => {
    const service = getSageService(port)!;
    for (const word of ['alpha', 'bravo', 'charlie']) {
      await service.rememberSage({ text: `Cursor walk fixture ${word} uses the walker module.` });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await service.unifiedSearchService(
        { text: 'walker', ...(cursor ? { cursor } : {}) },
        { limit: 1, ranking: 'recency' },
      );
      seen.push(...res.hits.map((h) => h.id));
      cursor = res.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(3);
    expect(seen).toHaveLength(3);
    await expect(
      service.unifiedSearchService({ text: 'walker', cursor: 'bogus' }),
    ).rejects.toBeInstanceOf(InvalidSearchCursorError);
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
