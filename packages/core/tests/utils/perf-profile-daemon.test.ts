/**
 * Daemon perf defaults.
 *
 * SQLite's `cache_size` / `mmap_size` pragmas are per connection, and a daemon
 * keeps its connections open for its whole life. The codebase-index daemon
 * measured 336MB RSS while completely idle — almost entirely the 128MiB page
 * cache plus the 512MiB mmap reservation from the `balanced` profile. Daemons
 * therefore default to `frugal`, but an operator's explicit setting must still
 * win in BOTH directions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['WRONGSTACK_PERF_PROFILE', 'WSTACK_PERF_PROFILE'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/**
 * Fresh module instance per test — the daemon opt-in is module state, and a
 * cached instance would leak `useDaemonPerfDefaults()` across tests. A query
 * suffix on the specifier does not work under Vite's transform, so reset the
 * module registry instead.
 */
async function loadFresh() {
  vi.resetModules();
  return import('../../src/utils/perf-profile.js');
}

describe('daemon perf defaults', () => {
  it('is balanced by default in a normal (non-daemon) process', async () => {
    const perf = await loadFresh();
    expect(perf.getPerfProfile()).toBe('balanced');
    expect(perf.sqliteCachePragmas().cacheSizeKiB).toBe(131_072);
  });

  it('switches to frugal once a daemon opts in', async () => {
    const perf = await loadFresh();
    perf.useDaemonPerfDefaults();
    expect(perf.getPerfProfile()).toBe('frugal');
    // 128 MiB -> 16 MiB page cache, 512 MiB -> 64 MiB mmap per connection.
    expect(perf.sqliteCachePragmas()).toEqual({
      cacheSizeKiB: 16_384,
      mmapBytes: 64 * 1024 * 1024,
    });
    expect(perf.SageCachePragmas()).toEqual({
      cacheSizeKiB: 8_192,
      mmapBytes: 32 * 1024 * 1024,
    });
  });

  it('lets an explicit operator setting override the daemon default', async () => {
    const perf = await loadFresh();
    perf.useDaemonPerfDefaults();
    process.env['WRONGSTACK_PERF_PROFILE'] = 'balanced';
    expect(perf.getPerfProfile()).toBe('balanced');
  });

  it('still honours an explicit frugal setting outside a daemon', async () => {
    const perf = await loadFresh();
    process.env['WRONGSTACK_PERF_PROFILE'] = 'frugal';
    expect(perf.getPerfProfile()).toBe('frugal');
  });

  it('treats an empty env value as unset rather than as balanced', async () => {
    const perf = await loadFresh();
    perf.useDaemonPerfDefaults();
    process.env['WRONGSTACK_PERF_PROFILE'] = '   ';
    expect(perf.getPerfProfile()).toBe('frugal');
  });
});
