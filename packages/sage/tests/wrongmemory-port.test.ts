import { WrongMemoryError } from '@wrongstack/wrongmemory-client';
import { describe, expect, it } from 'vitest';
import {
  type AutoSageMemoryPort,
  createSageMemoryPortForService,
  resolveSageServiceMode,
  SageBackendNotSelectedError,
} from '../src/memory-backend.js';
import {
  getSageRetrieval,
  getSageService,
  getSageSurface,
  SAGE_SERVICE_CAPABILITY,
} from '../src/memory-port.js';
import type { Sage } from '../src/types.js';
import {
  probeWrongMemoryProject,
  type WrongMemoryClientLike,
  WrongMemoryNotImplementedError,
  WrongMemoryPort,
  WrongMemoryProjectNotRegisteredError,
  WrongMemoryUnavailableError,
} from '../src/wrongmemory-port.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
const PROJECT = {
  projectId: 'p_1',
  displayName: 'proj',
  root: ROOT,
  storePath: '/data/p_1/sage.db',
  storeKind: 'managed',
  admission: 'read-write',
  admissionReason: 'service-managed store',
  ownerEpoch: 1,
  storageProfileId: null,
  createdAtMs: 0,
};

function memory(id: string, over: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: `memory ${id}`,
    importance: 0.5,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: `2026-01-0${id.length}T00:00:00Z`,
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

interface Call {
  method: string;
  params: Record<string, unknown>;
  projectId?: string | undefined;
}

class FakeClient implements WrongMemoryClientLike {
  calls: Call[] = [];
  closed = false;
  constructor(
    private readonly handler: (method: string, params: Record<string, unknown>) => unknown,
  ) {}
  async call<T>(
    method: string,
    params: unknown = {},
    opts: { projectId?: string } = {},
  ): Promise<T> {
    if (this.closed) throw new WrongMemoryError('TRANSPORT', 'connection closed');
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params: p, projectId: opts.projectId });
    const out = this.handler(method, p);
    if (out instanceof Error) throw out;
    return out as T;
  }
  close(): void {
    this.closed = true;
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  last(method: string): Call {
    const c = [...this.calls].reverse().find((x) => x.method === method);
    if (!c) throw new Error(`no ${method} call`);
    return c;
  }
}

function defaults(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'project.list':
      return { projects: [PROJECT] };
    case 'session.acquire':
      return { sessionId: params.hostSessionId, daemonIssued: false };
    case 'session.release':
      return { released: true };
    case 'daemon.health':
      return { status: 'ok', daemonInstanceId: 'd_1' };
    default:
      return undefined;
  }
}

function setup(
  handler: (method: string, params: Record<string, unknown>) => unknown = () => undefined,
  extra: Partial<ConstructorParameters<typeof WrongMemoryPort>[0]> = {},
) {
  const client = new FakeClient((m, p) => handler(m, p) ?? defaults(m, p));
  const connects: unknown[] = [];
  const port = new WrongMemoryPort({
    projectRoot: ROOT,
    connect: async (o) => {
      connects.push(o);
      return client;
    },
    ...extra,
  });
  return { client, port, connects };
}

describe('WrongMemoryPort mapping', () => {
  it('locates the project by root on initialize and scopes calls to it', async () => {
    const { client, port, connects } = setup((m) =>
      m === 'memory.search'
        ? { hits: [{ memory: memory('a'), channel: 'fts', score: 1 }] }
        : undefined,
    );
    await port.initialize();
    expect(port.getProject()?.projectId).toBe('p_1');
    expect(connects[0]).toMatchObject({ start: false, clientName: 'wrongstack' });
    const rows = await port.searchSage('auth', { limit: 5, includeStatuses: ['active'] });
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(client.last('memory.search')).toEqual({
      method: 'memory.search',
      params: { query: 'auth', limit: 5, statuses: ['active'] },
      projectId: 'p_1',
    });
  });

  it('registers an unknown root (managed) and honours an explicit projectId', async () => {
    const { client, port } = setup((m) => {
      if (m === 'project.list') return { projects: [] };
      if (m === 'project.register')
        return { project: { ...PROJECT, projectId: 'p_new' }, created: true };
      return undefined;
    });
    await port.initialize();
    expect(port.getProject()?.projectId).toBe('p_new');
    expect(client.last('project.register').params).toEqual({
      root: ROOT,
      storeKind: 'managed',
      write: true,
    });

    const byId = setup(
      (m) => (m === 'project.get' ? { ...PROJECT, projectId: 'p_9' } : undefined),
      {
        projectId: 'p_9',
      },
    );
    await byId.port.initialize();
    expect(byId.client.last('project.get').projectId).toBe('p_9');
    expect(byId.client.methods()).not.toContain('project.list');
  });

  it('refuses to register when register=false', async () => {
    const { port } = setup((m) => (m === 'project.list' ? { projects: [] } : undefined), {
      register: false,
    });
    await expect(port.initialize()).rejects.toBeInstanceOf(WrongMemoryProjectNotRegisteredError);
  });

  it('binds host sessions through session.acquire and releases for session-less calls', async () => {
    let session: string | undefined = 's1';
    const { client, port } = setup(
      (m) =>
        m === 'memory.forPath' || m === 'memory.search'
          ? { hits: [], truncated: false, corruptSkipped: 0, channel: 'path' }
          : undefined,
      { getSessionId: () => session },
    );
    await port.retrieveForPath({ path: 'src/a.ts', limit: 3 });
    await port.searchSage('x');
    await port.searchSage('x', { sessionId: 's2' });
    session = undefined;
    await port.searchSage('x');
    const sessionCalls = client.calls
      .filter((c) => c.method.startsWith('session.'))
      .map((c) => [c.method, c.params.hostSessionId]);
    expect(sessionCalls).toEqual([
      ['session.acquire', 's1'],
      ['session.acquire', 's2'],
      ['session.release', undefined],
    ]);
    expect(client.last('memory.forPath').params).toEqual({ path: 'src/a.ts', limit: 3 });
  });

  it('maps get/remember/update/feedback/delete/recover', async () => {
    const { client, port } = setup((m, p) => {
      switch (m) {
        case 'memory.get':
          return p.id === 'missing'
            ? new WrongMemoryError('NOT_FOUND', 'memory not found')
            : memory('a');
        case 'memory.remember':
        case 'memory.update':
        case 'memory.feedback':
        case 'memory.delete':
          return {
            outcome: 'memory-committed',
            id: 'a',
            revision: 2,
            replayed: false,
            record: memory('a', { revision: 2 }),
          };
        case 'memory.recover':
          return memory('a', { revision: 3 });
        default:
          return undefined;
      }
    });
    expect(await port.getSage('missing')).toBeNull();
    expect((await port.getSage('a'))?.id).toBe('a');

    const remembered = await port.rememberSage({
      text: 'Use pnpm',
      type: 'convention',
      priority: 'high',
      legacyScope: 'user-memory',
      tags: ['tooling'],
    });
    expect(remembered.revision).toBe(2);
    expect(client.last('memory.remember').params).toEqual({
      text: 'Use pnpm',
      kind: 'convention',
      scope: 'user',
      tags: ['tooling'],
      importance: 0.8,
    });

    await port.updateSage('a', { importance: 0.9, expectedRevision: 1, deleteAuthorized: true });
    expect(client.last('memory.update').params).toEqual({
      id: 'a',
      importance: 0.9,
      expectedRevision: 1,
    });

    await port.updateSage('a', {
      feedback: { verdict: 'useful', observedRevision: 2, evidence: 'test passed' },
    });
    expect(client.last('memory.feedback').params).toEqual({
      id: 'a',
      feedback: { verdict: 'useful', observedRevision: 2, evidence: 'test passed' },
    });
    expect(client.methods().filter((m) => m === 'memory.update')).toHaveLength(1);

    await port.deleteSage('a', 'obsolete', { force: true });
    expect(client.last('memory.delete').params).toEqual({
      id: 'a',
      reason: 'obsolete',
      force: true,
    });
    expect((await port.recoverSage('a', 'undo')).revision).toBe(3);
    expect(client.last('memory.recover').params).toEqual({ id: 'a', reason: 'undo' });
  });

  it('maps candidates: propose, list, accept, reject, resolve', async () => {
    const { client, port } = setup((m, p) => {
      switch (m) {
        case 'candidate.propose':
          return {
            outcome: 'candidate-pending',
            id: 'c1',
            replayed: false,
            record: { id: 'c1', status: 'pending' },
          };
        case 'candidate.list':
          return {
            candidates: [{ id: `c-${String(p.status)}` }],
            truncated: false,
            corruptSkipped: 0,
          };
        case 'candidate.accept':
          return {
            candidateId: 'c1',
            status: 'accepted',
            memoryId: 'm1',
            applied: true,
            alreadyResolved: false,
          };
        case 'memory.get':
          return memory('m1');
        case 'candidate.reject':
          return {
            candidateId: 'c2',
            status: 'rejected',
            applied: true,
            alreadyResolved: p.id === 'done',
          };
        case 'candidate.resolve':
          return {
            candidateId: 'c3',
            status: 'accepted',
            decision: 'archive',
            targetMemoryId: 'm2',
            applied: true,
            alreadyResolved: false,
          };
        default:
          return undefined;
      }
    });
    const candidate = await port.createCandidate({
      text: 'handler validates auth',
      targetMemoryId: 'm0',
      reviewReason: 'noise',
      suggestedAction: 'archive',
    });
    expect(candidate.id).toBe('c1');
    expect(client.last('candidate.propose').params).toEqual({
      text: 'handler validates auth',
      targetMemoryId: 'm0',
      reviewReason: 'noise',
      suggestedAction: 'archive',
    });
    expect((await port.listCandidates()).map((c) => c.id)).toEqual(['c-pending']);
    expect((await port.listCandidates(true)).map((c) => c.id)).toEqual([
      'c-pending',
      'c-accepted',
      'c-rejected',
      'c-merged',
    ]);
    expect((await port.acceptCandidate('c1'))?.id).toBe('m1');
    expect(await port.rejectCandidate('c2', 'dup')).toBe(true);
    expect(await port.rejectCandidate('done', 'dup')).toBe(false);
    expect(client.last('candidate.reject').params).toEqual({ id: 'done', reason: 'dup' });
    expect(await port.resolveCandidate('c3', 'archive', 'stale')).toEqual({
      candidateId: 'c3',
      decision: 'archive',
      targetMemoryId: 'm2',
      applied: true,
      alreadyResolved: false,
    });
  });

  it('maps listing, related, graph, stats, usage, backfill and hygiene', async () => {
    let page = 0;
    const { client, port } = setup((m) => {
      switch (m) {
        case 'memory.listPage':
          page++;
          return page === 1
            ? {
                memories: [memory('a'), memory('bb')],
                nextCursor: 'k1',
                total: 3,
                statusCounts: { active: 3 },
              }
            : {
                memories: [memory('bb'), memory('ccc', { scope: 'user' })],
                nextCursor: null,
                total: 3,
                statusCounts: { active: 3 },
              };
        case 'memory.related':
          return {
            hits: [{ memory: memory('r1') }, { memory: memory('r2', { status: 'stale' }) }],
          };
        case 'memory.graph':
          return {
            edges: [{ from: 'a', to: 'b', relation: 'related_to', weight: 0.5, createdAt: 't' }],
            memories: [],
            truncated: false,
          };
        case 'memory.stats':
          return {
            byStatus: { active: 2, deleted: 1 },
            byKind: { fact: 2 },
            pendingCandidates: 0,
            edges: 4,
          };
        case 'memory.recordUsage':
          return { recorded: 1 };
        case 'memory.backfill':
          return { dryRun: false, examined: 0 };
        case 'memory.hygiene':
          return { dryRun: true };
        default:
          return undefined;
      }
    });
    const all = await port.listSage();
    expect(all.map((m) => m.id)).toEqual(['a', 'bb', 'ccc']);
    expect(client.calls.filter((c) => c.method === 'memory.listPage')[1]?.params).toMatchObject({
      cursor: 'k1',
      limit: 200,
    });

    page = 0;
    const entries = await port.list('project-memory');
    expect(entries.map((e) => e.text)).toEqual(['memory bb', 'memory a']);
    page = 0;
    expect(await port.read('user-memory')).toContain('memory ccc');

    await port.listSagePage({ kind: 'all', limit: 999, statuses: ['active'] });
    expect(client.last('memory.listPage').params).toEqual({ statuses: ['active'], limit: 200 });

    const related = await port.findRelatedSage(['a'], {
      limit: 4,
      maxDepth: 2,
      includeStatuses: ['active'],
    });
    expect(related.map((m) => m.id)).toEqual(['r1']);
    expect(client.last('memory.related').params).toEqual({ ids: ['a'], limit: 4, maxDepth: 2 });

    expect(await port.graphFor('src/a.ts', 2, 10)).toEqual([
      {
        schemaVersion: 1,
        id: 'a->b:related_to',
        from: 'a',
        to: 'b',
        relation: 'related_to',
        weight: 0.5,
        createdAt: 't',
      },
    ]);
    expect(await port.stats()).toEqual({
      total: 3,
      byStatus: { active: 2, deleted: 1 },
      byKind: { fact: 2 },
      edges: 4,
    });

    const retrieval = getSageRetrieval(port);
    await retrieval?.recordInjection?.(['a'], 'tool:read', 's9');
    expect(client.last('memory.recordUsage').params).toEqual({
      ids: ['a'],
      kind: 'injection',
      label: 'tool:read',
    });
    expect(client.last('session.acquire').params).toEqual({ hostSessionId: 's9' });
    await retrieval?.recordUse?.(['a'], 'assistant');
    expect(client.last('memory.recordUsage').params).toMatchObject({
      kind: 'use',
      label: 'assistant',
    });
    await retrieval?.recordUse?.([], 'assistant');
    await retrieval?.flushPendingCounters?.();

    await port.backfillRecoverable({ dryRun: false, filter: { ids: ['x'] } });
    expect(client.last('memory.backfill').params).toEqual({ filter: { ids: ['x'] }, apply: true });
    await port.backfillRecoverable();
    expect(client.last('memory.backfill').params).toEqual({ filter: {}, apply: false });

    await port.hygiene({ retentionDays: 30, verify: true, bogus: 1 } as never);
    expect(client.last('memory.hygiene').params).toEqual({ retentionDays: 30, verify: true });
  });

  it('exposes all three capabilities and refuses unsupported operations with NOT_IMPLEMENTED', async () => {
    const { client, port } = setup((m) =>
      m === 'memory.search'
        ? { hits: [{ memory: memory('a', { scope: 'user' }) }, { memory: memory('b') }] }
        : undefined,
    );
    const service = getSageService(port);
    const surface = getSageSurface(port);
    expect(service).toBeDefined();
    expect(surface).toBeDefined();
    expect(port.getCapability({ id: 'other' } as never)).toBeUndefined();
    expect(service?.withTraceId('t1')).toBe(port.getCapability(SAGE_SERVICE_CAPABILITY));

    for (const run of [
      () => service!.verify(),
      () => service!.findMemoriesForFile('a.ts'),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(WrongMemoryNotImplementedError);
    }
    expect(surface?.verify).toBeUndefined();
    expect(surface?.readAudit).toBeUndefined();
    expect(getSageRetrieval(port)?.retrieveForAudience).toBeUndefined();
    // Nothing above reached the daemon: no local fallback, no silent call.
    expect(client.calls).toHaveLength(0);

    const breakdown = await port.searchSageWithBreakdown('q');
    expect(breakdown.map((h) => [h.memory.id, h.finalScore, h.source])).toEqual([
      ['a', 1, 'lexical'],
      ['b', 0, 'lexical'],
    ]);
    expect((await port.search('q', 'user-memory')).map((e) => e.text)).toEqual(['memory a']);
    expect((await port.findRelated('q')).map((e) => e.text)).toEqual(['memory b']);

    const unified = await port.unifiedSearchService(
      { text: 'q', scopes: ['project'] },
      { limit: 5 },
    );
    expect(unified.hits.map((h) => [h.id, h.matchReason])).toEqual([['b', 'lexical']]);
    expect(unified.matchChannel).toBe('fts');
    await expect(port.unifiedSearchService({ text: 'q', cursor: 'c' })).rejects.toBeInstanceOf(
      WrongMemoryNotImplementedError,
    );
  });

  it('turns a dropped connection into WrongMemoryUnavailableError and reconnects next call', async () => {
    let fail = true;
    const { client, port, connects } = setup((m) => {
      if (m === 'memory.search') {
        if (fail) return new WrongMemoryError('TRANSPORT', 'connection closed');
        return { hits: [] };
      }
      return undefined;
    });
    await expect(port.searchSage('q')).rejects.toBeInstanceOf(WrongMemoryUnavailableError);
    expect(client.closed).toBe(true);
    client.closed = false;
    fail = false;
    expect(await port.searchSage('q')).toEqual([]);
    expect(connects).toHaveLength(2);

    const conflict = setup((m) =>
      m === 'memory.update' ? new WrongMemoryError('REVISION_CONFLICT', 'stale') : undefined,
    );
    await expect(
      conflict.port.updateSage('a', { text: 'x', expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });

  it('fails initialize with WrongMemoryUnavailableError when no daemon is reachable', async () => {
    const port = new WrongMemoryPort({
      projectRoot: ROOT,
      startPolicy: 'never',
      connect: async (o) => {
        expect(o.start).toBe(false);
        throw new WrongMemoryError('UNAVAILABLE', 'no daemon');
      },
    });
    await expect(port.initialize()).rejects.toBeInstanceOf(WrongMemoryUnavailableError);
    expect((await port.health()).status).toBe('unavailable');
  });

  it('starts the daemon through its own sanitized launcher on demand, never via the client', async () => {
    const client = new FakeClient((m, p) => defaults(m, p));
    const launches: unknown[] = [];
    const port = new WrongMemoryPort({
      projectRoot: ROOT,
      daemonPath: '/bin/wrongmemoryd',
      connect: async (o) => {
        expect(o.start).toBe(false);
        throw new WrongMemoryError('UNAVAILABLE', 'no daemon');
      },
      startDaemon: async (o) => {
        launches.push(o.daemonPath);
        return client;
      },
    });
    await port.initialize();
    expect(launches).toEqual(['/bin/wrongmemoryd']);
    expect(port.getProject()?.projectId).toBe('p_1');
  });

  it('reports health from daemon.health and project admission', async () => {
    const { port } = setup();
    await port.initialize();
    expect(await port.health()).toMatchObject({
      status: 'ready',
      backend: 'wrongmemory',
      details: { projectId: 'p_1', admission: 'read-write' },
    });
    expect(port.getBackend()).toMatchObject({
      kind: 'wrongmemory',
      projectId: 'p_1',
      connected: true,
    });
    port.releaseConnection();
    await port.dispose();
    await expect(port.searchSage('q')).rejects.toBeInstanceOf(WrongMemoryUnavailableError);
  });
});

describe('Sage.service backend selection', () => {
  const localPort = () => ({ kind: 'local', initialize: async () => {} }) as never;

  it('defaults to local and only accepts known modes', () => {
    expect(resolveSageServiceMode(undefined)).toBe('local');
    expect(resolveSageServiceMode({ mode: 'bogus' as never })).toBe('local');
    expect(resolveSageServiceMode({ mode: 'auto' })).toBe('auto');
    const port = createSageMemoryPortForService({ projectRoot: ROOT, createLocal: localPort });
    expect((port as unknown as { kind: string }).kind).toBe('local');
  });

  it('wrongmemory mode never constructs the local store', () => {
    const port = createSageMemoryPortForService({
      projectRoot: ROOT,
      service: { mode: 'wrongmemory' },
      createLocal: () => {
        throw new Error('local store constructed');
      },
    });
    expect(port).toBeInstanceOf(WrongMemoryPort);
  });

  it('auto picks WrongMemory only when the daemon is reachable and the project registered', async () => {
    const auto = createSageMemoryPortForService({
      projectRoot: ROOT,
      service: { mode: 'auto' },
      connect: async () => new FakeClient((m, p) => defaults(m, p)),
      createLocal: () => {
        throw new Error('local store constructed');
      },
    }) as AutoSageMemoryPort;
    expect(() => auto.getCapability(SAGE_SERVICE_CAPABILITY)).toThrow(SageBackendNotSelectedError);
    expect((await auto.health()).status).toBe('unavailable');
    await auto.initialize();
    expect(auto.getSelectedBackend()).toBe('wrongmemory');
    expect(getSageService(auto)).toBeDefined();

    const unregistered = createSageMemoryPortForService({
      projectRoot: ROOT,
      service: { mode: 'auto' },
      connect: async () =>
        new FakeClient((m) => (m === 'project.list' ? { projects: [] } : undefined)),
      createLocal: localPort,
    }) as AutoSageMemoryPort;
    await unregistered.initialize();
    expect(unregistered.getSelectedBackend()).toBe('local');

    const down = createSageMemoryPortForService({
      projectRoot: ROOT,
      service: { mode: 'auto' },
      connect: async () => {
        throw new WrongMemoryError('UNAVAILABLE', 'no daemon');
      },
      createLocal: localPort,
    }) as AutoSageMemoryPort;
    await down.initialize();
    expect(down.getSelectedBackend()).toBe('local');
  });

  it('probe never starts a daemon and closes its connection', async () => {
    const client = new FakeClient((m, p) => defaults(m, p));
    const project = await probeWrongMemoryProject({
      projectRoot: ROOT,
      connect: async (o) => {
        expect(o.start).toBe(false);
        return client;
      },
    });
    expect(project?.projectId).toBe('p_1');
    expect(client.closed).toBe(true);
  });
});
