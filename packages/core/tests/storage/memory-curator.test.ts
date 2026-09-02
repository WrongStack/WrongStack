import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/core/agent-types.js';
import type { Context } from '../../src/core/context.js';
import {
  type CuratorSage,
  type CuratorSageRecord,
  SessionMemoryCurator,
} from '../../src/storage/memory-curator.js';
import type { MemoryStore } from '../../src/types/memory.js';
import type { Provider } from '../../src/types/provider.js';

const mkStore = () =>
  ({
    list: vi.fn(async () => [] as never[]),
    remember: vi.fn(async () => {}),
    forget: vi.fn(async () => 1),
  }) as never as MemoryStore;

const mkCuratorSage = () =>
  ({
    rememberSage: vi.fn(async () => ({ id: 'mem_new_123' })),
    updateSage: vi.fn(async () => ({})),
    deleteSage: vi.fn(async () => {}),
    getSage: vi.fn(async (_id: string) => null),
    listCandidates: vi.fn(async () => []),
    retrieveForPath: vi.fn(async () => []),
    searchSage: vi.fn(async () => []),
  }) satisfies CuratorSage;

const mkProvider = (text: string): Provider =>
  ({
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' })),
  }) as never as Provider;

const ctx = (provider?: Provider, overrides: Partial<Context> = {}): Context =>
  ({
    provider,
    model: 'haiku',
    session: { id: '2026-08-28/sess_curator' },
    projectRoot: '/project',
    writtenFiles: new Set(['/project/src/auth.ts']),
    readFiles: new Set(['/project/src/user.ts']),
    ...overrides,
  }) as never as Context;

const result = (over: Partial<RunResult> = {}): RunResult =>
  ({
    status: 'done',
    finalText: 'Updated auth logic to use JWT tokens',
    iterations: 3,
    ...over,
  }) as RunResult;

describe('SessionMemoryCurator', () => {
  let store: MemoryStore;
  let sage: CuratorSage;

  beforeEach(() => {
    store = mkStore();
    sage = mkCuratorSage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips non-done sessions', async () => {
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage });
    await curator.afterRun(ctx(mkProvider('{}')), result({ status: 'failed' }));
    expect(sage.retrieveForPath).not.toHaveBeenCalled();
  });

  it('skips when no files are written and no candidates exist', async () => {
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage });
    await curator.afterRun(ctx(mkProvider('{}'), { writtenFiles: new Set<string>() }), result());
    expect(sage.retrieveForPath).not.toHaveBeenCalled();
  });

  it('skips LLM call when 0 candidate memories match written files', async () => {
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([]);
    const provider = mkProvider('{}');
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.retrieveForPath).toHaveBeenCalledWith({
      path: 'src/auth.ts',
      limit: 4,
      includeStatuses: ['active', 'stale'],
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('executes supersede and contradict operations', async () => {
    const existingMem: CuratorSageRecord = {
      id: 'mem_auth_old',
      text: 'Auth uses basic cookie sessions',
      kind: 'convention',
      status: 'active',
      importance: 0.8,
      confidence: 0.9,
    };
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([existingMem]);

    const providerResponse = JSON.stringify({
      operations: [
        {
          action: 'supersede',
          targetId: 'mem_auth_old',
          reason: 'Switched to JWT in this session',
        },
      ],
    });
    const provider = mkProvider(providerResponse);
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.updateSage).toHaveBeenCalledWith('mem_auth_old', {
      status: 'superseded',
    });
  });

  it('executes merge operations', async () => {
    const mem1: CuratorSageRecord = {
      id: 'mem_1',
      text: 'Auth checks token expiry',
      kind: 'fact',
      status: 'active',
    };
    const mem2: CuratorSageRecord = {
      id: 'mem_2',
      text: 'Auth validates token signature',
      kind: 'fact',
      status: 'active',
    };
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([mem1, mem2]);

    const providerResponse = JSON.stringify({
      operations: [
        {
          action: 'merge',
          targetIds: ['mem_1', 'mem_2'],
          text: 'Auth validates token signature and expiry',
          type: 'convention',
          priority: 'high',
          confidence: 0.95,
          reason: 'Combined related auth token rules',
        },
      ],
    });
    const provider = mkProvider(providerResponse);
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Auth validates token signature and expiry',
        kind: 'convention',
        importance: 0.8,
        confidence: 0.95,
        supersedes: ['mem_1', 'mem_2'],
      }),
    );
    expect(sage.updateSage).toHaveBeenCalledWith(
      'mem_1',
      expect.objectContaining({ status: 'superseded' }),
    );
    expect(sage.updateSage).toHaveBeenCalledWith(
      'mem_2',
      expect.objectContaining({ status: 'superseded' }),
    );
  });

  it('executes split operations', async () => {
    const bloatedMem: CuratorSageRecord = {
      id: 'mem_bloated',
      text: 'Auth uses JWT tokens and the database uses PostgreSQL with Prisma',
      kind: 'fact',
      status: 'active',
    };
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([bloatedMem]);

    const providerResponse = JSON.stringify({
      operations: [
        {
          action: 'split',
          targetId: 'mem_bloated',
          items: [
            { text: 'Auth uses JWT tokens', type: 'convention', priority: 'high' },
            { text: 'Database uses PostgreSQL with Prisma', type: 'fact', priority: 'high' },
          ],
          reason: 'Split auth and database concerns',
        },
      ],
    });
    const provider = mkProvider(providerResponse);
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.rememberSage).toHaveBeenCalledTimes(2);
    expect(sage.updateSage).toHaveBeenCalledWith('mem_bloated', { status: 'superseded' });
  });

  it('executes recalibrate operations', async () => {
    const mem: CuratorSageRecord = {
      id: 'mem_recal',
      text: 'Temporary debug log in auth service',
      kind: 'file_note',
      status: 'active',
      importance: 0.7,
      confidence: 0.8,
    };
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([mem]);

    const providerResponse = JSON.stringify({
      operations: [
        {
          action: 'recalibrate',
          targetId: 'mem_recal',
          importance: 0.2,
          freshness: 0.5,
          status: 'archived',
          reason: 'Demoted temporary debug note to archived',
        },
      ],
    });
    const provider = mkProvider(providerResponse);
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.updateSage).toHaveBeenCalledWith('mem_recal', {
      importance: 0.2,
      freshness: 0.5,
      status: 'archived',
    });
  });

  it('protects permanent persistence memories from deletion, supersede, and archival', async () => {
    const permanentMem: CuratorSageRecord = {
      id: 'mem_permanent_core',
      text: 'Core architecture rule: never expose raw private keys',
      kind: 'warning',
      status: 'active',
      persistence: 'permanent',
    };
    vi.mocked(sage.retrieveForPath!).mockResolvedValueOnce([permanentMem]);

    const providerResponse = JSON.stringify({
      operations: [
        {
          action: 'supersede',
          targetId: 'mem_permanent_core',
          reason: 'Attempt to supersede permanent architecture rule',
        },
      ],
    });
    const provider = mkProvider(providerResponse);
    const curator = new SessionMemoryCurator({ memoryStore: store, Sage: sage, provider });

    await curator.afterRun(ctx(provider), result());

    expect(sage.updateSage).not.toHaveBeenCalled();
  });
});
