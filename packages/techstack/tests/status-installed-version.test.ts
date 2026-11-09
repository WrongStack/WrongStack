import { ClientRequest, IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyStatus } from '../src/policy/status.js';
import { clearRegistryCache } from '../src/registry/client.js';
import { parsePurl } from '../src/registry/purl.js';
import { runEnrichPhase } from '../src/service/enrich-phase.js';
import type { DependencyObservation, Snapshot } from '../src/types.js';

vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  get: vi.fn(),
}));

afterEach(() => {
  vi.mocked(httpsGet).mockReset();
  clearRegistryCache();
});

function observation(versions: Partial<DependencyObservation>): DependencyObservation {
  return {
    id: 'dep',
    workspaceId: 'ws',
    ecosystem: 'npm',
    name: 'example',
    purl: 'pkg:npm/example',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    status: 'current',
    evidence: [],
    requested: '^1.0.0',
    ...versions,
  };
}

describe('status classification of observed versions', () => {
  it.each([
    [{ installed: '1.0.0' }, '1.0.1', 'update_available_safe'],
    [{ installed: '1.0.0' }, '2.0.0', 'update_available_breaking'],
    [{ installed: '0.2.3', requested: '^0.2.0' }, '0.3.0', 'update_available_breaking'],
    [{ installed: '2.0.0' }, '2.0.0', 'current'],
    [{ installed: '3.0.0' }, '2.0.0', 'current'],
    [{ locked: '1.0.0', installed: '2.0.0' }, '2.0.0', 'update_available_breaking'],
    [{ locked: '2.0.0', installed: '1.0.0' }, '2.0.0', 'current'],
    [{ installed: '1.0.0-alpha.1' }, '1.0.0', 'update_available_safe'],
    [{ installed: '1.0.0', requested: undefined }, '1.1.0', 'update_available_safe'],
    [{ installed: '0.2.3', requested: ' ^0.2.0 ' }, '0.3.0', 'update_available_breaking'],
    [{ installed: '1.0.0', requested: 'v1.0.0' }, '2.0.0', 'update_available_breaking'],
  ] as const)('classifies %j against %s as %s', (versions, latestStable, expected) => {
    expect(classifyStatus(observation(versions), { latestStable })).toBe(expected);
  });

  it('rejects malformed PURL types containing spaces or invalid characters (F136)', () => {
    expect(parsePurl('pkg:bad type!/react@1.0.0')).toBeUndefined();
    expect(parsePurl('pkg:123/react@1.0.0')).toBeUndefined();
  });

  it.each([
    [{ lookupFailed: true }, 'unknown'],
    [{ privateOrUnresolved: true }, 'private_or_unresolved'],
    [{ deprecated: true }, 'deprecated'],
    [{ yanked: true }, 'yanked'],
  ] as const)('preserves registry priority %j', (registry, expected) => {
    expect(
      classifyStatus(observation({ installed: '1.0.0' }), {
        latestStable: '2.0.0',
        ...registry,
      }),
    ).toBe(expected);
  });

  it('preserves advisory priority over installed-version comparison', () => {
    expect(
      classifyStatus(
        observation({ installed: '1.0.0' }),
        { latestStable: '2.0.0' },
        { hasAdvisory: true },
      ),
    ).toBe('vulnerable');
  });
});

it.each([{ installed: '1.0.0' }, { locked: '1.0.0', installed: '2.0.0' }])(
  'emits the real enrichment upgrade finding for %j',
  async (versions) => {
    clearRegistryCache();
    vi.mocked(httpsGet).mockImplementation((...args: unknown[]) => {
      const callback = args.find(
        (arg): arg is (response: IncomingMessage) => void => typeof arg === 'function',
      );
      if (!callback) throw new Error('Missing HTTPS response callback');
      const response = new IncomingMessage(new Socket());
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit(
          'data',
          JSON.stringify({
            'dist-tags': { latest: '2.0.0' },
            license: 'MIT',
          }),
        );
        response.emit('end');
      });
      const request = Object.create(ClientRequest.prototype) as ClientRequest;
      request.end = vi.fn();
      request.destroy = vi.fn(() => request);
      return request;
    });
    const snapshot: Snapshot = {
      id: 'snapshot',
      projectId: 'project',
      targetRoot: '.',
      fingerprint: 'fixed',
      createdAt: '2026-10-12T00:00:00.000Z',
      adapterVersion: '1.1.0',
      coverage: 'full',
      workspaces: [],
      findings: [],
      dependencies: [observation(versions)],
    };
    const enriched = await runEnrichPhase(snapshot);
    expect(enriched.dependencies[0]?.status).toBe('update_available_breaking');
    expect(enriched.findings).toContainEqual(
      expect.objectContaining({
        dependencyId: 'dep',
        type: 'upgrade',
        action: 'upgrade_major',
      }),
    );
    expect(httpsGet).toHaveBeenCalledTimes(1);
  },
);
