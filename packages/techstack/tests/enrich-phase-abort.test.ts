import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'abort-registry' | 'abort-osv' | 'network-error',
  aborted: false,
}));

vi.mock('../src/registry/client.js', () => ({
  RegistryAuthError: class RegistryAuthError extends Error {},
  RegistryNotFoundError: class RegistryNotFoundError extends Error {},
  lookupRegistry: vi.fn(async () => {
    if (state.mode === 'abort-registry') {
      state.aborted = true;
      throw new DOMException('Aborted', 'AbortError');
    }
    if (state.mode === 'network-error') {
      throw new Error('ECONNREFUSED');
    }
    return {
      latestStable: '2.0.0',
      license: 'MIT',
      source: 'npm',
      retrievedAt: '2026-01-01T00:00:00.000Z',
    };
  }),
}));

vi.mock('../src/advisory/osv.js', () => ({
  queryOsvBatch: vi.fn(async () => {
    if (state.mode === 'abort-osv') {
      state.aborted = true;
      throw new DOMException('Aborted', 'AbortError');
    }
    return {
      advisories: new Map(),
      evidence: {
        kind: 'advisory',
        source: 'osv',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        detail: '',
      },
    };
  }),
}));

import { runEnrichPhase } from '../src/service/enrich-phase.js';

function makeSnapshot(): Parameters<typeof runEnrichPhase>[0] {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    targetRoot: '/repo',
    createdAt: '2026-01-01T00:00:00.000Z',
    adapterVersion: '1.0.0',
    fingerprint: 'fp',
    workspaces: [],
    dependencies: [
      {
        id: 'dep-1',
        workspaceId: 'root',
        ecosystem: 'npm' as const,
        name: 'demo-pkg',
        requested: '^1.0.0',
        locked: '1.0.0',
        installed: '1.0.0',
        purl: 'pkg:npm/demo-pkg@1.0.0',
        direct: true,
        sourceType: 'registry' as const,
        status: 'unknown' as const,
        evidence: [],
      },
    ],
    findings: [],
  } as unknown as Parameters<typeof runEnrichPhase>[0];
}

function makeDynamicSignal(): AbortSignal {
  return {
    get aborted() {
      return state.aborted;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

describe('runEnrichPhase abort propagation (F933)', () => {
  beforeEach(() => {
    state.mode = 'ok';
    state.aborted = false;
  });

  it('rejects with AbortError when signal aborts during lookupRegistry', async () => {
    state.mode = 'abort-registry';
    await expect(
      runEnrichPhase(makeSnapshot(), { online: true, signal: makeDynamicSignal() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError when signal aborts during queryOsvBatch', async () => {
    state.mode = 'abort-osv';
    await expect(
      runEnrichPhase(makeSnapshot(), { online: true, signal: makeDynamicSignal() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('still degrades gracefully on non-abort network errors', async () => {
    state.mode = 'network-error';
    const result = await runEnrichPhase(makeSnapshot(), {
      online: true,
      signal: makeDynamicSignal(),
    });
    expect(result.dependencies).toHaveLength(1);
  });
});
