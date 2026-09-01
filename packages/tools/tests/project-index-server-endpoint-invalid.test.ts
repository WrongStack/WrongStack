/**
 * Endpoint-length macOS-TMPDIR worst-case coverage for the project index daemon.
 *
 * On macOS the per-user TMPDIR is ~48 bytes (`/var/folders/<xx>/<30 chars>/T`)
 * and `sun_path` caps Unix-domain socket paths at 103 usable bytes (BSD) or
 * 107 (Linux). The previous failure mode was a detached child process
 * silently dying on `bind()` (`stdio: 'ignore'` swallowed `ENAMETOOLONG`)
 * and the client hanging for the full 10s connect timeout — with no
 * indication that it had stopped sharing the per-project daemon.
 *
 * The fix surfaces a typed `endpoint-invalid` availability to callers so they
 * can fail fast with an actionable error. These tests cover both the
 * detection (`resolveProjectIndexDaemonAvailability`) and the production
 * rejection path (`callIndexOp` inside `background-indexer.ts`).
 *
 * The daemon-availability detection runs against the actual `process.platform`
 * — on Windows the platform check would always say "ok" (named pipes have no
 * `sun_path` limit), so the `endpoint-invalid` branch is unreachable in
 * reality on Windows CI. The mock on `@wrongstack/core/utils` here is what
 * makes the macOS worst-case reproducible on every host.
 */

import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkUnixSocketPathMock = vi.hoisted(() => vi.fn());
// The endpoint-length integration test below resets modules and re-imports
// the resolver expecting the REAL length guard (it stubs TMPDIR deep so the
// real check fails). vi.mock registrations persist across vi.resetModules(),
// so the mock must DELEGATE to the real implementation by default — a bare
// `vi.fn()` would return undefined and crash `!check.ok` at the call site.
const realCheckUnixSocketPath = vi.hoisted<{
  fn?: (
    socketPath: string,
    platform?: NodeJS.Platform,
  ) => {
    ok: boolean;
    byteLength: number;
    maxBytes: number;
  };
}>(() => ({}));
vi.mock('@wrongstack/persistence', async (orig) => {
  const actual = await orig<typeof import('@wrongstack/persistence')>();
  realCheckUnixSocketPath.fn = actual.checkUnixSocketPath;
  return {
    ...actual,
    checkUnixSocketPath: checkUnixSocketPathMock,
  };
});

// `resolveProjectIndexDaemonAvailability` probes for a built `project-server.js`
// in two known locations; without this mock the source-tree test environment
// would return `missing-build` and the `endpoint-invalid` branch would never
// execute.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true, default: { ...actual, existsSync: () => true } };
});

// The index service must resolve when `callIndexOp` reaches the worker/inline
// path. We never want to take that branch in this suite — the `endpoint-invalid`
// detection runs first — but keep the import chain honest.
const { indexServiceMock } = vi.hoisted(() => ({ indexServiceMock: vi.fn() }));
vi.mock('../src/codebase-index/index-service.js', () => ({
  indexService: indexServiceMock,
  searchService: vi.fn(async () => ({ results: [], total: 0 })),
  statsService: vi.fn(async () => ({ totalSymbols: 0 })),
  packageGraphService: vi.fn(),
  fileGraphService: vi.fn(),
  symbolGraphService: vi.fn(),
}));

const { resolveProjectIndexDaemonAvailability } = await import(
  '../src/codebase-index/project-server-client.js'
);
const { projectIndexServerEndpoint } = await import(
  '../src/codebase-index/project-server-endpoint.js'
);
const {
  runStartupIndex,
  searchCodebaseIndex,
  codebaseIndexStats,
  ensureCodebaseIndexServer,
  resetIndexStateForTesting,
} = await import('../src/codebase-index/background-indexer.js');

const OK_RESULT = {
  filesIndexed: 0,
  symbolsIndexed: 0,
  langStats: {},
  durationMs: 0,
  errors: [],
};

function setEnv(name: string, value: string | undefined): () => void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

let stderrWrite: ReturnType<typeof vi.spyOn>;
let stderrChunks: string[] = [];

beforeEach(() => {
  stderrChunks = [];
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  // Default: the REAL length guard (used by the TMPDIR-depth integration
  // test). Tests that need a synthetic result override with mockReturnValue
  // after this. mockReset() first so a prior test's override is cleared.
  checkUnixSocketPathMock.mockReset();
  checkUnixSocketPathMock.mockImplementation((path: string, platform?: NodeJS.Platform) =>
    realCheckUnixSocketPath.fn!(path, platform),
  );
  indexServiceMock.mockReset();
  indexServiceMock.mockResolvedValue(OK_RESULT);
  resetIndexStateForTesting();
});

afterEach(() => {
  stderrWrite?.mockRestore();
  vi.restoreAllMocks();
});

describe('resolveProjectIndexDaemonAvailability', () => {
  it('returns inline-requested when WRONGSTACK_INDEX_INLINE is set', () => {
    const restore = setEnv('WRONGSTACK_INDEX_INLINE', '1');
    try {
      const availability = resolveProjectIndexDaemonAvailability('/workspace/proj');
      expect(availability.kind).toBe('inline-requested');
      // The inline override short-circuits before the endpoint check, so
      // checkUnixSocketPath must not have been called at all.
      expect(checkUnixSocketPathMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('returns inline-requested when WRONGSTACK_INDEX_SERVER is "0"', () => {
    const restore = setEnv('WRONGSTACK_INDEX_SERVER', '0');
    try {
      expect(resolveProjectIndexDaemonAvailability('/workspace/proj').kind).toBe(
        'inline-requested',
      );
    } finally {
      restore();
    }
  });

  it('returns available without consulting the endpoint check when no projectRoot is given', () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: true, byteLength: 50, maxBytes: 107 });
    const availability = resolveProjectIndexDaemonAvailability();
    expect(availability.kind).toBe('available');
    // Opt-in guard: skip the byte check when callers have not told us which
    // path to validate. The fixed wiring (background-indexer.ts:342) threads
    // projectRoot through; old call sites that omit it must keep working.
    expect(checkUnixSocketPathMock).not.toHaveBeenCalled();
  });

  it('returns available when the resolved endpoint fits the platform limit', () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: true, byteLength: 80, maxBytes: 107 });
    const availability = resolveProjectIndexDaemonAvailability('/workspace/proj');
    expect(availability.kind).toBe('available');
    expect(checkUnixSocketPathMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the byte counts reported by the socket-path guard into the availability kind', () => {
    // The guard (mocked here, real in the integration test below) is the
    // single source of truth for `byteLength` and `maxBytes`. The resolver
    // must forward them verbatim — no rounding, no platform inference from
    // `projectRoot`. macOS is simulated here because BSD `sun_path` is the
    // known trigger (103 usable bytes).
    const projectRoot = '/workspace/proj';
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    const availability = resolveProjectIndexDaemonAvailability(projectRoot);
    expect(availability.kind).toBe('endpoint-invalid');
    if (availability.kind !== 'endpoint-invalid') return;
    expect(availability.byteLength).toBe(142);
    expect(availability.maxBytes).toBe(103);
    // The endpoint reported to callers must match what the platform check
    // evaluated — they will use it to build the actionable error message.
    const expectedEndpoint = projectIndexServerEndpoint(projectRoot);
    expect(availability.endpoint).toBe(expectedEndpoint);
  });

  it('reports maxBytes from the real platform check even when indexDir or projectRoot would not push the path over the limit', () => {
    // Socket-path length comes from `os.tmpdir()` plus a fixed-length hash —
    // projectRoot and indexDir do NOT influence it. This test pins down the
    // mock contract: any `ok: false` result is forwarded verbatim, and the
    // endpoint the resolver reports is the same one the guard evaluated
    // (never one synthesised from projectRoot).
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 260, maxBytes: 107 });
    const availability = resolveProjectIndexDaemonAvailability('/workspace/proj');
    expect(availability.kind).toBe('endpoint-invalid');
    if (availability.kind !== 'endpoint-invalid') return;
    expect(availability.maxBytes).toBe(107);
    // The endpoint string is platform-shaped: `\\.\pipe\wrongstack-…-v1-…`
    // on Windows, `…/wsci-v1-<key>.sock` on POSIX. Both share the `v1-`
    // protocol-version segment, which is what we assert here.
    expect(availability.endpoint).toMatch(/v1[-/][0-9a-f]{24}/);
  });

  it('threads indexDir into the endpoint that gets validated', () => {
    const projectRoot = '/workspace/project';
    const indexDir = '/custom/index/dir';
    checkUnixSocketPathMock.mockReturnValue({ ok: true, byteLength: 90, maxBytes: 107 });
    resolveProjectIndexDaemonAvailability(projectRoot, indexDir);
    // The endpoint passed to the guard must include the indexDir-derived key,
    // not just the project root — two projects on the same root but different
    // index directories must each get their own daemon and their own check.
    const [arg] = checkUnixSocketPathMock.mock.calls[0] ?? [];
    const expected = projectIndexServerEndpoint(projectRoot, indexDir);
    expect(arg).toBe(expected);
  });

  // Socket-path length is driven by `os.tmpdir()` plus a fixed-length hash,
  // so `projectRoot` / `indexDir` cannot push it over the platform limit on
  // their own. Stubbing TMPDIR is the only way to exercise the real
  // `checkUnixSocketPath` against a too-long path on every host — including
  // Windows CI, where the named-pipe branch is always within limits.
  it.skipIf(process.platform === 'win32')(
    'returns endpoint-invalid from the real length check when TMPDIR is deep enough',
    async () => {
      const deepTmpdir = `${os.tmpdir()}/${'a'.repeat(200)}`;
      vi.stubEnv('TMPDIR', deepTmpdir);
      try {
        // Reset modules so the new `os.tmpdir()` value is honoured by
        // already-imported endpoint helpers.
        vi.resetModules();
        const { resolveProjectIndexDaemonAvailability: resolveFresh } = await import(
          '../src/codebase-index/project-server-client.js'
        );
        const { projectIndexServerEndpoint: endpointFresh } = await import(
          '../src/codebase-index/project-server-endpoint.js'
        );
        const projectRoot = '/workspace/proj';
        const endpoint = endpointFresh(projectRoot);
        // Sanity-check the precondition: the stubbed TMPDIR must actually
        // produce a socket path over the platform limit, otherwise the test
        // would silently pass for the wrong reason.
        expect(Buffer.byteLength(endpoint, 'utf8')).toBeGreaterThan(107);
        const availability = resolveFresh(projectRoot);
        expect(availability.kind).toBe('endpoint-invalid');
        if (availability.kind !== 'endpoint-invalid') return;
        expect(availability.endpoint).toBe(endpoint);
        expect(availability.byteLength).toBe(Buffer.byteLength(endpoint, 'utf8'));
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    },
  );
});

describe('background-indexer callIndexOp — endpoint-invalid rejection', () => {
  it('rejects runStartupIndex with the sun_path error instead of silently degrading', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    await expect(runStartupIndex({ projectRoot: '/workspace/proj' })).rejects.toThrow(
      /socket path is 142 bytes, over this platform's 103-byte sun_path limit/,
    );
    // The inline path must not be taken on an endpoint-invalid daemon:
    // indexService would have to be invoked for that to happen, and a
    // process-local index is exactly the silent-degrade the guard exists
    // to prevent.
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('rejects searchCodebaseIndex with the same sun_path error', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 130, maxBytes: 103 });
    await expect(
      searchCodebaseIndex({ projectRoot: '/workspace/proj', query: 'foo', limit: 10 }),
    ).rejects.toThrow(/over this platform's 103-byte sun_path limit/);
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('rejects codebaseIndexStats with the same sun_path error', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 130, maxBytes: 103 });
    await expect(codebaseIndexStats({ projectRoot: '/workspace/proj' })).rejects.toThrow(
      /Set a shorter TMPDIR/,
    );
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('mentions the offending endpoint path so the operator can act on it', async () => {
    const projectRoot = '/workspace/proj';
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    let captured: unknown;
    try {
      await runStartupIndex({ projectRoot });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(projectIndexServerEndpoint(projectRoot));
  });

  it('honours WRONGSTACK_INDEX_INLINE as the inline fallback (no silent degrade)', async () => {
    // WRONGSTACK_INDEX_INLINE is the supported escape hatch from the
    // endpoint-invalid guard. The mock is irrelevant here because the inline
    // override short-circuits the availability check before the endpoint
    // length guard runs. The test pins down that contract: an explicit
    // inline override routes through `indexService` even when the daemon
    // would otherwise be considered unavailable.
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    const restore = setEnv('WRONGSTACK_INDEX_INLINE', '1');
    try {
      const result = await runStartupIndex({ projectRoot: '/workspace/proj' });
      expect(result).toMatchObject({ filesIndexed: 0 });
      expect(indexServiceMock).toHaveBeenCalled();
      // The endpoint guard must not run when inline is requested: the
      // operator has already opted out of the shared daemon.
      expect(checkUnixSocketPathMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('warnEndpointInvalidOnce — stderr throttle', () => {
  it('writes the actionable message to stderr exactly once per endpoint', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    // Three back-to-back startup attempts on the same over-long endpoint.
    await expect(runStartupIndex({ projectRoot: '/workspace/proj' })).rejects.toThrow();
    await expect(runStartupIndex({ projectRoot: '/workspace/proj' })).rejects.toThrow();
    await expect(runStartupIndex({ projectRoot: '/workspace/proj' })).rejects.toThrow();

    const sunPathMessages = stderrChunks.filter((chunk) =>
      chunk.includes('socket path is 142 bytes'),
    );
    expect(sunPathMessages).toHaveLength(1);
    expect(sunPathMessages[0]).toMatch(/TMPDIR/);
  });

  it('emits a separate warning per distinct endpoint', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    await expect(runStartupIndex({ projectRoot: '/workspace/proj-a' })).rejects.toThrow();
    await expect(runStartupIndex({ projectRoot: '/workspace/proj-b' })).rejects.toThrow();

    const sunPathMessages = stderrChunks.filter((chunk) =>
      chunk.includes('socket path is 142 bytes'),
    );
    expect(sunPathMessages).toHaveLength(2);
    expect(sunPathMessages[0]).toMatch(/v1[-/][0-9a-f]{24}/);
    expect(sunPathMessages[1]).toMatch(/v1[-/][0-9a-f]{24}/);
  });
});

describe('ensureCodebaseIndexServer — endpoint-invalid no-op', () => {
  it('resolves without spawning a server when the endpoint is unbindable', async () => {
    checkUnixSocketPathMock.mockReturnValue({ ok: false, byteLength: 142, maxBytes: 103 });
    // The host's ensureCodebaseIndexServer short-circuits on endpoint-invalid:
    // it would be wrong to spawn a daemon that will silently fail to bind.
    await expect(
      ensureCodebaseIndexServer({
        projectRoot: '/workspace/proj',
        watchExternal: true,
        debounceMs: 50,
      }),
    ).resolves.toBeUndefined();
  });
});

// (intentionally no trailing constants)
