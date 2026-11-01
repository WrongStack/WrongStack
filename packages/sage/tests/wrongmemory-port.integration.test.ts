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
import { createWrongMemoryHqSyncConnection } from '../src/memory-backend.js';
import {
  createProjectSageMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
} from '../src/memory-port.js';
import { createSagePathRemapMiddleware } from '../src/middleware/path-remap.js';
import { InvalidSearchCursorError } from '../src/service-contract.js';
import { handOffSageToWrongMemory } from '../src/wrongmemory-handoff.js';
import { prepareWrongMemoryMcpBridge } from '../src/wrongmemory-mcp-bridge.js';
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

  it('HQ sync runs through the daemon in wrongmemory mode (WM-408)', async () => {
    expect(
      createWrongMemoryHqSyncConnection({ projectRoot: proj, service: { mode: 'local' } }),
    ).toBeUndefined();
    const conn = createWrongMemoryHqSyncConnection({
      projectRoot: proj,
      service: { mode: 'wrongmemory', dataRoot: home, daemonPath: DAEMON, startPolicy: 'never' },
    })!;
    try {
      const shared = await getSageService(port)!.rememberSage({ text: 'HQ: shared via daemon' });
      const version = String(await conn.call('getHqSyncVersion', {}));
      expect(version).toMatch(/^[0-9a-f]{32}:\d+$/);
      const ids: string[] = [];
      let after = '';
      for (;;) {
        const page = (await conn.call('listHqSync', { after })) as Array<{ id: string }>;
        if (page.length === 0) break;
        ids.push(...page.map((r) => r.id));
        after = page[page.length - 1]!.id;
      }
      expect(ids).toContain(shared.id);
      const at = new Date().toISOString();
      const remoteId = 'hq-remote-integration-1';
      await conn.call('applyHqSync', {
        records: [
          {
            id: remoteId,
            revision: 1,
            changeId: 'ab'.repeat(16),
            memory: {
              schemaVersion: 1,
              id: remoteId,
              revision: 1,
              text: 'HQ remote: arrives through the daemon',
              kind: 'fact',
              scope: 'project',
              status: 'active',
              importance: 0.5,
              confidence: 0.8,
              freshness: 1,
              tags: [],
              anchors: [],
              sources: [{ type: 'user' }],
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
      });
      expect((await getSageService(port)!.getSage(remoteId))?.text).toBe(
        'HQ remote: arrives through the daemon',
      );
    } finally {
      conn.close?.();
    }
  });

  it('serves the memory MCP endpoint through a scoped WrongMemory grant (WM-407)', async () => {
    const service = {
      mode: 'wrongmemory' as const,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'never' as const,
    };
    const first = await prepareWrongMemoryMcpBridge({
      projectRoot: proj,
      service,
      origin: 'acp-worker-1',
    });
    const again = await prepareWrongMemoryMcpBridge({
      projectRoot: proj,
      service,
      origin: 'acp-worker-2',
    });
    expect(again.grantId).toBe(first.grantId);
    expect(first.args).toEqual([
      '--data-root',
      expect.any(String),
      'mcp',
      '--project',
      first.projectId,
      '--grant',
      first.grantId,
      '--client',
      'acp-worker-1',
    ]);
    // Only ids on the command line; the secret stays in the data root.
    expect(first.args.join(' ')).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(first.command.toLowerCase()).toContain('wrongmemory');

    await getSageService(port)!.rememberSage({ text: 'Bridge: the worker can recall this' });
    const { spawn } = await import('node:child_process');
    const child = spawn(first.command, first.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i = buf.indexOf('\n');
      while (i >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = async (id: number) => {
      for (let t = 0; t < 200; t++) {
        const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no reply ${id}`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    await reply(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await reply(2)).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('memory_search');
    expect(tools).not.toContain('memory_remember');
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'worker can recall' } },
    });
    const found = await reply(3);
    expect(found.result.isError).toBe(false);
    expect(JSON.stringify(found.result)).toContain('the worker can recall this');
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  });

  it('fuses a caller-owned vector channel once, never leaking hidden or stale ids (WM-405)', async () => {
    const svc = getSageService(port)!;
    const both = await svc.rememberSage({ text: 'Fusion: rollbacks use the blue-green switch' });
    const vectorOnly = await svc.rememberSage({
      text: 'Fusion: deploy reversal goes through traffic flip',
    });
    const foreign = await svc.rememberSage({
      text: 'Fusion: another session private rollback idea',
      scope: 'session',
      ownerSessionId: 'fusion-other-session',
    });
    const gone = await svc.rememberSage({ text: 'Fusion: a rollback note that was deleted' });
    await svc.deleteSage(gone.id, 'obsolete', { force: true });
    const calls: unknown[] = [];
    const vectorRecall = {
      async search(_q: string, opts: unknown) {
        calls.push(opts);
        return [both, vectorOnly, foreign, gone, { id: 'mem_does_not_exist', text: 'x' }].map(
          // The vector mirror links its rows to SAGE by `metadata.sageId`.
          (m, i) => ({
            id: `vec-${i}`,
            score: 0.95 - i * 0.001,
            text: m.text,
            metadata: { sageId: m.id },
          }),
        );
      },
    };
    const hits = await svc.searchSageWithBreakdown('rollbacks blue-green', {
      vectorRecall,
      sessionId: 'fusion-me',
      limit: 10,
    } as never);
    const byId = new Map(hits.map((h) => [h.memory.id, h.source]));
    expect(byId.get(both.id)).toBe('both');
    expect(byId.get(vectorOnly.id)).toBe('vector');
    expect(byId.has(foreign.id)).toBe(false);
    expect(byId.has(gone.id)).toBe(false);
    expect(byId.has('mem_does_not_exist')).toBe(false);
    expect(calls).toHaveLength(1); // one fusion, one vector query
    const flat = await svc.searchSage('rollbacks blue-green', {
      vectorRecall,
      sessionId: 'fusion-me',
      limit: 10,
    } as never);
    expect(flat.map((m) => m.id)).toEqual(hits.map((h) => h.memory.id));
    // Without a vector channel the port stays lexical (the host wrapper fuses).
    const lexical = await svc.searchSageWithBreakdown('rollbacks blue-green', { limit: 10 });
    expect(lexical.every((h) => h.source === 'lexical')).toBe(true);
  });

  it('local SAGE refuses a store a live WrongMemory owner holds (WM-107)', async () => {
    const root = path.join(tmp, 'guarded');
    mkdirSync(root, { recursive: true });
    const seed = createProjectSageMemoryPort({ projectRoot: root });
    await seed.initialize?.();
    await getSageService(seed)!.rememberSage({ text: 'Guard: written by local SAGE first' });
    await seed.dispose?.();

    const owner = new WrongMemoryPort({
      projectRoot: root,
      dataRoot: home,
      daemonPath: DAEMON,
      startPolicy: 'never',
      timeoutMs: 15_000,
    });
    await owner.initialize();
    const project = owner.getProject()!;
    expect(project.storeKind).toBe('adopted');
    const viaService = await getSageService(owner)!.rememberSage({
      text: 'Guard: written through WrongMemory',
    });
    await owner.dispose();

    const second = createProjectSageMemoryPort({ projectRoot: root });
    await expect(
      (async () => {
        await second.initialize?.();
        return getSageSurface(second)!.listSage(['active']);
      })(),
    ).rejects.toMatchObject({ code: 'SAGE_STORE_OWNED_BY_WRONGMEMORY' });
    await second.dispose?.().catch(() => undefined);

    // Releasing the store in WrongMemory hands it back to local SAGE.
    const host = await WrongMemoryClient.connect({ dataRoot: home, clientName: 'guard' });
    try {
      await host.call(METHODS.PROJECT_DETACH, { projectId: project.projectId });
    } finally {
      host.close();
    }
    const third = createProjectSageMemoryPort({ projectRoot: root });
    await third.initialize?.();
    const texts = (await getSageSurface(third)!.listSage(['active'])).map((m) => m.text);
    expect(texts).toContain('Guard: written through WrongMemory');
    expect(texts).toContain('Guard: written by local SAGE first');
    expect(viaService.id).toBeTruthy();
    await third.dispose?.();
  });

  it('hands a local SAGE store off to WrongMemory cooperatively (WM-107)', async () => {
    const root = path.join(tmp, 'handoff');
    mkdirSync(root, { recursive: true });
    const seed = createProjectSageMemoryPort({ projectRoot: root });
    await seed.initialize?.();
    await getSageService(seed)!.rememberSage({ text: 'Handoff: local fact survives' });
    await seed.dispose?.();
    // A stale server.json, as a crashed local owner leaves behind.
    writeFileSync(path.join(root, '.wrongstack', 'memories', 'server.json'), '{}');
    let alive = true;
    const shutdowns: unknown[] = [];
    const local = {
      status: async () => (alive ? { pid: 1 } : null),
      shutdown: async (reason?: string) => {
        shutdowns.push(reason);
        alive = false;
        return { stopped: true };
      },
    };
    const service = { mode: 'wrongmemory' as const, dataRoot: home };
    const plan = await handOffSageToWrongMemory({
      projectRoot: root,
      service,
      apply: false,
      local,
    });
    expect(plan.applied).toBe(false);
    expect(plan.localServerRunning).toBe(true);
    expect(shutdowns).toEqual([]);

    const done = await handOffSageToWrongMemory({ projectRoot: root, service, apply: true, local });
    expect(shutdowns).toEqual(['handoff-to-wrongmemory']);
    expect(done).toMatchObject({
      applied: true,
      localServerStopped: true,
      admission: 'read-write',
      ownerLocked: true,
    });

    // WrongMemory serves the adopted store; local SAGE now refuses it.
    const wm = new WrongMemoryPort({
      projectRoot: root,
      dataRoot: home,
      startPolicy: 'never',
      timeoutMs: 15_000,
    });
    await wm.initialize();
    const hits = await getSageService(wm)!.searchSage('local fact survives');
    expect(hits.map((m) => m.text)).toContain('Handoff: local fact survives');
    await wm.dispose();
    const blocked = createProjectSageMemoryPort({ projectRoot: root });
    await expect(
      (async () => {
        await blocked.initialize?.();
        return getSageSurface(blocked)!.listSage(['active']);
      })(),
    ).rejects.toMatchObject({ code: 'SAGE_STORE_OWNED_BY_WRONGMEMORY' });
    await blocked.dispose?.().catch(() => undefined);
  });

  it('consolidateSession turns session facts into candidates (WM-511 surface)', async () => {
    await getSageService(port)!.rememberSage({ text: 'Consolidate: lockfiles are committed' });
    const result = await port.consolidateSession({
      sessionId: 'consolidate-s1',
      autoAcceptThreshold: 0.8,
      facts: [
        {
          text: 'Consolidate: lockfiles are committed',
          kind: 'convention',
          confidence: 0.9,
          importance: 0.9,
        },
        {
          text: 'Consolidate: release notes live in CHANGELOG.md',
          kind: 'fact',
          confidence: 0.95,
          importance: 0.9,
        },
        {
          text: 'Consolidate: maybe rename the CLI someday',
          kind: 'fact',
          confidence: 0.3,
          importance: 0.2,
        },
        { text: '   ', kind: 'fact', confidence: 0.9, importance: 0.9 },
      ],
    } as never);
    expect(result).toEqual({ candidates: 2, accepted: 1, rejected: 0, duplicate: 2 });
    const accepted = await getSageService(port)!.searchSage('release notes CHANGELOG');
    expect(accepted.map((m) => m.text)).toContain(
      'Consolidate: release notes live in CHANGELOG.md',
    );
    const pending = await getSageSurface(port)!.listCandidates();
    expect(pending.map((c) => c.text)).toContain('Consolidate: maybe rename the CLI someday');
  });

  it('consolidation proposals supersede members; a stale review stays pending (WM-511)', async () => {
    const service = getSageService(port)!;
    const surface = getSageSurface(port)!;
    const m1 = await service.rememberSage({ text: 'Merge: queue workers retry three times' });
    const m2 = await service.rememberSage({ text: 'Merge: failed jobs are retried by workers' });
    await expect(
      surface.createCandidate({
        text: 'Merge: members without revisions are invalid',
        supersedesMemoryIds: [m1.id],
      }),
    ).rejects.toThrow(/supersedesMemoryIds needs 1-50 distinct ids/);
    const merge = await surface.createCandidate({
      text: 'Background job policy: a failed job gets exactly three attempts before dead-lettering',
      suggestedAction: 'consolidate',
      supersedesMemoryIds: [m1.id, m2.id],
      supersedesRevisions: [m1.revision, m2.revision],
    });
    expect(merge.supersedesMemoryIds).toEqual([m1.id, m2.id]);
    const keeper = await surface.acceptCandidate(merge.id);
    for (const member of [m1, m2]) {
      const after = await service.getSage(member.id);
      expect([after?.status, after?.supersededBy]).toEqual(['superseded', keeper!.id]);
    }

    const target = await service.rememberSage({ text: 'Review: the staging cache is Redis 7' });
    const review = await surface.createCandidate({
      text: 'Review: staging cache note is obsolete',
      kind: 'memory_review',
      targetMemoryId: target.id,
      targetRevision: target.revision + 6,
      suggestedAction: 'archive',
    });
    const resolution = await surface.resolveCandidate(review.id, 'archive');
    expect(resolution).toMatchObject({ applied: false, targetMemoryId: target.id });
    expect(resolution?.error).toMatch(/revision changed/);
    expect((await service.getSage(target.id))?.status).toBe('active');
    expect((await surface.listCandidates()).map((c) => c.id)).toContain(review.id);
    expect(await surface.rejectCandidate(review.id, 'stale')).toBe(true);
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
    // Prompt-context relevance (core's prompt enhancer) is served too.
    const scored = await port.scoreRelevant!(
      { currentTask: 'cargo build --locked release' },
      'project-memory',
      5,
    );
    expect(scored[0]).toMatchObject({
      text: 'Release builds use cargo build --locked',
      score: 1,
      matchReason: 'SAGE lexical search',
    });
  });
});
