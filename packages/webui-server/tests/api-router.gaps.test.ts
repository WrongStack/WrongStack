import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The router statically imports every handler family. Mock them all so the
// tests assert dispatch decisions (status codes, argument wiring, auth gates)
// without touching real stores, engines, or the filesystem.
vi.mock('../src/server/http-server/api-handlers.js', () => ({
  handleApiSessions: vi.fn(),
  handleApiSessionAgents: vi.fn(),
  handleApiSessionEvents: vi.fn(),
  handleApiSessionMessage: vi.fn(),
  handleApiSessionMailbox: vi.fn(),
  handleApiSessionInterrupt: vi.fn(),
  handleApiFleetBroadcast: vi.fn(),
}));
vi.mock('../src/server/http-server/analytics-handler.js', () => ({
  handleApiAnalyticsGet: vi.fn(),
  handleApiAnalyticsPost: vi.fn(),
  handleApiAnalyticsSummary: vi.fn(),
}));
vi.mock('../src/server/http-server/vector-memory-handlers.js', () => ({
  handleVectorMemoryForget: vi.fn(),
  handleVectorMemorySearch: vi.fn(),
  handleVectorMemoryStatus: vi.fn(),
  handleVectorMemoryStore: vi.fn(),
  handleMemorySearch: vi.fn(),
}));
vi.mock('../src/server/requirement-intake-handlers.js', () => ({
  handleRequirementIntakeAnswers: vi.fn(),
  handleRequirementIntakeArchive: vi.fn(),
  handleRequirementIntakeCancel: vi.fn(),
  handleRequirementIntakeCreate: vi.fn(),
  handleRequirementIntakeGet: vi.fn(),
  handleRequirementIntakeList: vi.fn(),
  handleRequirementIntakeListForServer: vi.fn(),
  handleRequirementIntakeSubmit: vi.fn(),
  handleRequirementIntakeSuggestions: vi.fn(),
  handleRequirementIntakeUpdate: vi.fn(),
}));
vi.mock('../src/server/codemap-handlers.js', () => ({
  handleCodemapFiles: vi.fn(),
  handleCodemapPackages: vi.fn(),
  handleCodemapSymbols: vi.fn(),
}));
vi.mock('../src/server/deadcode-handlers.js', () => ({
  handleDeadCodeActionPlan: vi.fn(),
  handleDeadCodeScan: vi.fn(),
}));
vi.mock('../src/server/memory-diagnostics.js', () => ({
  readRecentProcessMemoryDiagnostics: vi.fn(async () => [{ pid: 1 }]),
}));
vi.mock('../src/server/techstack-handlers.js', () => ({
  handleTechStackAnalyze: vi.fn(),
  handleTechStackCancel: vi.fn(),
  handleTechStackDependencyResearch: vi.fn(),
  handleTechStackInventory: vi.fn(),
  handleTechStackJobStatus: vi.fn(),
  handleTechStackRemediationApply: vi.fn(),
  handleTechStackRemediationPlan: vi.fn(),
  handleTechStackReport: vi.fn(),
  handleTechStackSnapshot: vi.fn(),
  handleTechStackTrends: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({
  getIndexState: vi.fn(() => ({ server: 'running' })),
}));

import { handleApiRoutes } from '../src/server/http-server/api-router.js';
import * as apiHandlers from '../src/server/http-server/api-handlers.js';
import * as analyticsHandlers from '../src/server/http-server/analytics-handler.js';
import * as vectorHandlers from '../src/server/http-server/vector-memory-handlers.js';
import * as intakeHandlers from '../src/server/requirement-intake-handlers.js';
import * as codemapHandlers from '../src/server/codemap-handlers.js';
import * as deadcodeHandlers from '../src/server/deadcode-handlers.js';
import * as techstackHandlers from '../src/server/techstack-handlers.js';

const api = apiHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const analytics = analyticsHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const vector = vectorHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const intake = intakeHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const codemap = codemapHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const deadcode = deadcodeHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;
const tech = techstackHandlers as unknown as Record<string, ReturnType<typeof vi.fn>>;

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function fakeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead: vi.fn((code: number, headers: Record<string, string> = {}) => {
      res.statusCode = code;
      Object.assign(res.headers, headers);
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk !== undefined) res.body = chunk;
    }),
  };
  return res as unknown as FakeRes;
}

function fakeReq(method: string): http.IncomingMessage {
  return { method, headers: {} } as unknown as http.IncomingMessage;
}

const RUNTIME = async () =>
  ({ store: {}, engine: {}, runningJobs: new Map() }) as never as Awaited<
    ReturnType<Parameters<typeof handleApiRoutes>[6]>
  >;

async function route(
  method: string,
  pathname: string,
  deps: Record<string, unknown> = {},
  opts: { requireAccessToken?: boolean; accessTokenOk?: boolean; search?: string } = {},
): Promise<{ handled: boolean; res: FakeRes; url: URL }> {
  const res = fakeRes();
  const url = new URL(`http://localhost${pathname}${opts.search ?? ''}`);
  const handled = await handleApiRoutes(
    fakeReq(method),
    res as never,
    url,
    { projectRoot: '/proj', globalRoot: '/global', ...deps } as never,
    opts.requireAccessToken ?? true,
    opts.accessTokenOk ?? true,
    RUNTIME,
  );
  return { handled, res, url };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleApiRoutes — session and fleet routes', () => {
  it('dispatches fleet ping and tolerates a throwing callback', async () => {
    const ok = await route('POST', '/api/fleet/ping');
    expect(ok.handled).toBe(true);
    expect(ok.res.statusCode).toBe(204);

    const throwing = await route('POST', '/api/fleet/ping', {
      onFleetPing: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.res.statusCode).toBe(204);
  });

  it('lists sessions and per-session agents, events, mailbox, and messages', async () => {
    await route('GET', '/api/sessions');
    expect(api['handleApiSessions']).toHaveBeenCalledWith(expect.anything(), '/global');

    await route('GET', '/api/sessions/my-session/agents');
    expect(api['handleApiSessionAgents']).toHaveBeenCalledWith(
      expect.anything(),
      '/global',
      'my-session',
    );

    await route('GET', '/api/sessions/encoded%2Fid/mailbox');
    expect(api['handleApiSessionMailbox']).toHaveBeenCalledWith(
      expect.anything(),
      '/global',
      'encoded/id',
    );

    await route('POST', '/api/sessions/s1/message');
    expect(api['handleApiSessionMessage']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/global',
      's1',
    );

    await route('POST', '/api/sessions/s1/interrupt');
    expect(api['handleApiSessionInterrupt']).toHaveBeenCalled();

    await route('POST', '/api/fleet/broadcast');
    expect(api['handleApiFleetBroadcast']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/global',
    );
  });

  it('clamps the events limit query into [1, 500]', async () => {
    await route('GET', '/api/sessions/s1/events', {}, { search: '?limit=9999' });
    expect(api['handleApiSessionEvents']).toHaveBeenLastCalledWith(
      expect.anything(),
      '/global',
      's1',
      500,
    );

    await route('GET', '/api/sessions/s1/events', {}, { search: '?limit=0' });
    expect(api['handleApiSessionEvents']).toHaveBeenLastCalledWith(
      expect.anything(),
      '/global',
      's1',
      1,
    );

    await route('GET', '/api/sessions/s1/events', {}, { search: '?limit=abc' });
    expect(api['handleApiSessionEvents']).toHaveBeenLastCalledWith(
      expect.anything(),
      '/global',
      's1',
      200,
    );

    await route('GET', '/api/sessions/s1/events');
    expect(api['handleApiSessionEvents']).toHaveBeenLastCalledWith(
      expect.anything(),
      '/global',
      's1',
      200,
    );
  });

  it('rejects protected routes with 401 when the access token is missing', async () => {
    for (const [method, path] of [
      ['POST', '/api/fleet/ping'],
      ['GET', '/api/sessions'],
      ['GET', '/api/sessions/s1/agents'],
      ['GET', '/api/sessions/s1/events'],
      ['POST', '/api/sessions/s1/message'],
      ['GET', '/api/sessions/s1/mailbox'],
      ['POST', '/api/sessions/s1/interrupt'],
      ['POST', '/api/fleet/broadcast'],
      ['GET', '/api/analytics'],
      ['POST', '/api/analytics'],
      ['GET', '/api/analytics/summary'],
      ['GET', '/api/vector-memory/status'],
      ['GET', '/api/memory/search'],
      ['GET', '/api/techstack/snapshot'],
    ] as const) {
      const out = await route(method, path, {}, { accessTokenOk: false });
      expect(out.handled, path).toBe(true);
      expect(out.res.statusCode, path).toBe(401);
      expect(JSON.parse(out.res.body).error).toBe('Unauthorized');
    }
  });
});

describe('handleApiRoutes — analytics', () => {
  it('dispatches POST, GET, and summary', async () => {
    await route('POST', '/api/analytics');
    expect(analytics['handleApiAnalyticsPost']).toHaveBeenCalled();

    const get = await route('GET', '/api/analytics');
    expect(analytics['handleApiAnalyticsGet']).toHaveBeenCalledWith(get.res as never, get.url);

    await route('GET', '/api/analytics/summary');
    expect(analytics['handleApiAnalyticsSummary']).toHaveBeenCalled();
  });
});

describe('handleApiRoutes — requirement intake routes', () => {
  it('lists per-server and per-project intakes and creates new ones', async () => {
    await route('GET', '/api/requirement-intakes');
    expect(intake['handleRequirementIntakeListForServer']).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      '/proj',
    );

    await route('POST', '/api/projects/proj%20one/requirement-intakes');
    expect(intake['handleRequirementIntakeCreate']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      'proj one',
    );

    await route('GET', '/api/projects/proj-one/requirement-intakes');
    expect(intake['handleRequirementIntakeList']).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      'proj-one',
    );
  });

  it('gets and updates a single intake', async () => {
    await route('GET', '/api/requirement-intakes/intake-1');
    expect(intake['handleRequirementIntakeGet']).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      'intake-1',
    );

    await route('PATCH', '/api/requirement-intakes/intake-1');
    expect(intake['handleRequirementIntakeUpdate']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      'intake-1',
    );
  });

  it.each(['answers', 'suggestions', 'cancel'] as const)(
    'dispatches the %s intake action with the request body',
    async (action) => {
      await route('POST', `/api/requirement-intakes/intake-1/${action}`);
      const handlerName = `handleRequirementIntake${action[0]!.toUpperCase()}${action.slice(1)}`;
      expect(intake[handlerName]).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        'intake-1',
      );
    },
  );

  it.each(['submit', 'archive'] as const)(
    'dispatches the %s intake action without a request body',
    async (action) => {
      await route('POST', `/api/requirement-intakes/intake-1/${action}`);
      const handlerName = `handleRequirementIntake${action[0]!.toUpperCase()}${action.slice(1)}`;
      expect(intake[handlerName]).toHaveBeenCalledWith(expect.anything(), undefined, 'intake-1');
    },
  );
});

describe('handleApiRoutes — codemap routes', () => {
  it('requires a configured project root with 503', async () => {
    const out = await route('GET', '/api/codemap/packages', { projectRoot: undefined });
    expect(out.handled).toBe(true);
    expect(out.res.statusCode).toBe(503);
    expect(JSON.parse(out.res.body).error).toBe('Project root not configured');
  });

  it('dispatches packages, files, and symbols with query params', async () => {
    await route('GET', '/api/codemap/packages', { indexDir: '/idx' });
    expect(codemap['handleCodemapPackages']).toHaveBeenCalledWith(expect.anything(), {
      projectRoot: '/proj',
      indexDir: '/idx',
    });

    const files = await route('GET', '/api/codemap/files', {}, { search: '?package=pkg-a' });
    expect(codemap['handleCodemapFiles']).toHaveBeenCalledWith(
      expect.anything(),
      { projectRoot: '/proj' },
      'pkg-a',
    );
    expect(files.handled).toBe(true);

    await route('GET', '/api/codemap/symbols', {}, { search: '?file=src/a.ts' });
    expect(codemap['handleCodemapSymbols']).toHaveBeenCalledWith(
      expect.anything(),
      { projectRoot: '/proj' },
      'src/a.ts',
    );
  });
});

describe('handleApiRoutes — techstack routes', () => {
  it('rejects the whole family with 503 without a project root', async () => {
    const out = await route('GET', '/api/techstack/snapshot', { projectRoot: undefined });
    expect(out.handled).toBe(true);
    expect(out.res.statusCode).toBe(503);
  });

  it('surfaces runtime failures as a 503 with a sanitized detail', async () => {
    const out = await route('GET', '/api/techstack/snapshot', {});
    const boom = await handleApiRoutes(
      fakeReq('GET'),
      out.res as never,
      new URL('http://localhost/api/techstack/snapshot'),
      { projectRoot: '/proj' } as never,
      false,
      true,
      async () => {
        throw new Error('store exploded');
      },
    );
    expect(boom).toBe(true);
    expect(out.res.statusCode).toBe(503);
    expect(JSON.parse(out.res.body).error).toBe('TechStack store unavailable');
    expect(JSON.parse(out.res.body).detail).toBeTypeOf('string');
  });

  it('dispatches snapshot, inventory, analyze, and trends with the runtime deps', async () => {
    await route('GET', '/api/techstack/snapshot');
    expect(tech['handleTechStackSnapshot']).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: '/proj', projectRoot: '/proj' }),
    );

    await route('POST', '/api/techstack/inventory');
    expect(tech['handleTechStackInventory']).toHaveBeenCalled();

    await route('POST', '/api/techstack/analyze');
    expect(tech['handleTechStackAnalyze']).toHaveBeenCalled();

    await route('GET', '/api/techstack/trends');
    expect(tech['handleTechStackTrends']).toHaveBeenCalled();

    await route('GET', '/api/techstack/remediation');
    expect(tech['handleTechStackRemediationPlan']).toHaveBeenCalled();

    await route('POST', '/api/techstack/remediation/apply');
    expect(tech['handleTechStackRemediationApply']).toHaveBeenCalled();
  });

  it('dispatches job, report, and dependency-research routes with decoded params', async () => {
    await route('POST', '/api/techstack/jobs/job%201/cancel');
    expect(tech['handleTechStackCancel']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'job 1',
    );

    await route('GET', '/api/techstack/jobs/job-2');
    expect(tech['handleTechStackJobStatus']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'job-2',
    );

    const report = await route(
      'GET',
      '/api/techstackreports'.replace('techstackreports', 'techstack/reports/r-1'),
      {},
      { search: '?format=spdx' },
    );
    expect(tech['handleTechStackReport']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'r-1',
      'spdx',
    );
    expect(report.handled).toBe(true);

    await route('GET', '/api/techstack/reports/r-2', {}, { search: '?format=bogus' });
    expect(tech['handleTechStackReport']).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'r-2',
      'md',
    );

    await route('POST', '/api/techstack/deps/pkg%20x/research');
    expect(tech['handleTechStackDependencyResearch']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pkg x',
    );
  });

  it('rejects malformed URI encoding in techstack path params with 400', async () => {
    const cases = [
      ['POST', '/api/techstack/jobs/%ZZ/cancel'],
      ['GET', '/api/techstack/jobs/%ZZ'],
      ['GET', '/api/techstack/reports/%ZZ'],
      ['POST', '/api/techstack/deps/%ZZ/research'],
    ] as const;
    for (const [method, path] of cases) {
      const out = await route(method, path);
      expect(out.res.statusCode, path).toBe(400);
      expect(JSON.parse(out.res.body).error, path).toBe('Invalid URI encoding in path parameter');
    }
  });
});

describe('handleApiRoutes — debug and deadcode routes', () => {
  it('reports watcher metrics with the average debounce delay', async () => {
    const out = await route('GET', '/debug/watcher-metrics', {
      watcherMetrics: { broadcastsSent: 4, totalDebounceDelayMs: 100, dropped: 0 },
    });
    expect(out.res.statusCode).toBe(200);
    const body = JSON.parse(out.res.body);
    expect(body.averageDebounceDelayMs).toBe(25);
    expect(body.timestamp).toBeTypeOf('number');
  });

  it('averages to zero when no broadcasts were sent and 503s without metrics', async () => {
    const zero = await route('GET', '/debug/watcher-metrics', {
      watcherMetrics: { broadcastsSent: 0, totalDebounceDelayMs: 0 },
    });
    expect(JSON.parse(zero.res.body).averageDebounceDelayMs).toBe(0);

    const missing = await route('GET', '/debug/watcher-metrics');
    expect(missing.res.statusCode).toBe(503);
    expect(JSON.parse(missing.res.body).error).toBe('File watcher metrics not available');
  });

  it('exposes /debug/system without an access-token gate', async () => {
    const out = await route('GET', '/debug/system', {}, { accessTokenOk: false });
    expect(out.handled).toBe(true);
    expect(out.res.statusCode).toBe(200);
    const body = JSON.parse(out.res.body);
    expect(body.pid).toBe(process.pid);
    expect(body.codebaseIndexServer).toBe('running');
    expect(body.processes).toEqual([{ pid: 1 }]);
    expect(out.res.headers['Cache-Control']).toBe('no-store');
  });

  it('requires a project root for deadcode scans with 400', async () => {
    const out = await route('POST', '/api/deadcode/scan', { projectRoot: undefined });
    expect(out.res.statusCode).toBe(400);
    expect(JSON.parse(out.res.body).error).toBe('Project root not configured');
  });

  it('dispatches deadcode scan and action-plan', async () => {
    await route('POST', '/api/deadcode/scan', { indexDir: '/idx' });
    expect(deadcode['handleDeadCodeScan']).toHaveBeenCalledWith(
      expect.anything(),
      { projectRoot: '/proj', indexDir: '/idx' },
      expect.anything(),
    );

    await route('POST', '/api/deadcode/action-plan');
    expect(deadcode['handleDeadCodeActionPlan']).toHaveBeenCalledWith(
      expect.anything(),
      { projectRoot: '/proj', indexDir: undefined },
      expect.anything(),
    );
  });
});

describe('handleApiRoutes — memory routes', () => {
  it('dispatches the four vector-memory routes plus SAGE search', async () => {
    await route('DELETE', '/api/vector-memory/store/mem%201');
    expect(vector['handleVectorMemoryForget']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );

    await route('GET', '/api/vector-memory/status', {
      projectRoot: '/proj',
      vectorMemoryModelCacheDir: '/cache',
    });
    expect(vector['handleVectorMemoryStatus']).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { projectRoot: '/proj', modelCacheDir: '/cache' },
    );

    await route('GET', '/api/vector-memory/search');
    expect(vector['handleVectorMemorySearch']).toHaveBeenCalled();

    await route('POST', '/api/vector-memory/store');
    expect(vector['handleVectorMemoryStore']).toHaveBeenCalled();

    await route('GET', '/api/memory/search');
    expect(vector['handleMemorySearch']).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('hands the lazily-resolved store getter to the vector handlers', async () => {
    let calls = 0;
    await route('GET', '/api/vector-memory/status', {
      getVectorMemoryStore: () => {
        calls += 1;
        return { store: true } as never;
      },
    });
    // The handler is mocked, so invoke the getter it received ourselves.
    const vectorCalls = vector['handleVectorMemoryStatus']?.mock.calls as unknown[][];
    const getter = vectorCalls[0]?.[1] as (() => unknown) | undefined;
    expect(getter).toBeTypeOf('function');
    getter?.();
    expect(calls).toBe(1);
  });
});

describe('handleApiRoutes — fallthrough', () => {
  it('answers unknown /api paths with a 404 and keeps the no-store header', async () => {
    const out = await route('GET', '/api/does-not-exist');
    expect(out.handled).toBe(true);
    expect(out.res.statusCode).toBe(404);
    expect(out.res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(out.res.body).error).toBe('Not found');
  });

  it('does not claim non-API paths', async () => {
    const out = await route('GET', '/index.html');
    expect(out.handled).toBe(false);
    expect(out.res.statusCode).toBe(0);
  });

  it('does not match API paths with the wrong method', async () => {
    const out = await route('DELETE', '/api/sessions');
    // Falls through to the generic /api 404, not the sessions handler.
    expect(out.res.statusCode).toBe(404);
    expect(api['handleApiSessions']).not.toHaveBeenCalled();
  });
});
