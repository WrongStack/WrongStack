import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdate,
  currentVersion,
  fetchLatestFromNpm,
  getUpdateNotification,
  isNewer,
} from '../src/update-check.js';
import { expectFetchError } from './helpers/fetch-error.js';

describe('update-check', () => {
  let tmp: string;
  let userHome: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-upd-'));
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-upd-home-'));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(userHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────── currentVersion

  describe('currentVersion()', () => {
    it('returns a semver string from package.json', () => {
      const v = currentVersion();
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('returns truthy value (either semver or "dev")', () => {
      expect(currentVersion()).toBeTruthy();
      expect(typeof currentVersion()).toBe('string');
    });
  });

  // ─────────────────────────────────────────────────────────────── checkForUpdate

  describe('checkForUpdate()', () => {
    it('returns outdated:false when already on latest', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: currentVersion() }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const info = await checkForUpdate(undefined, () => userHome);

      expect(info.outdated).toBe(false);
      expect(info.checkFailed).toBe(false);
      expect(info.current).toBe(currentVersion());
      expect(info.latest).toBe(currentVersion());
    });

    it('returns outdated:true when npm has newer version', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '999.999.999' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const info = await checkForUpdate(undefined, () => userHome);

      expect(info.outdated).toBe(true);
      expect(info.latest).toBe('999.999.999');
      expect(info.checkFailed).toBe(false);
    });

    it('returns checkFailed:true when network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
      vi.stubGlobal('fetch', mockFetch);

      const info = await checkForUpdate(undefined, () => userHome);

      expect(info.checkFailed).toBe(true);
      expect(info.outdated).toBe(false);
    });

    it('aborts when signal is already aborted', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: currentVersion() }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const ac = new AbortController();
      ac.abort();

      const info = await checkForUpdate(ac.signal, () => userHome);

      expect(info.outdated).toBe(false);
      expect(info.checkFailed).toBe(true);
    });

    it('returns checkFailed:true when npm returns non-ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as never as Response);
      vi.stubGlobal('fetch', mockFetch);

      const info = await checkForUpdate(undefined, () => userHome);

      expect(info.checkFailed).toBe(true);
      expect(info.outdated).toBe(false);
    });

    it('non-2xx npm response throws a structured FetchError (checkForUpdate + npmjs context)', async () => {
      // The previous test only asserted the user-facing `checkFailed: true`
      // surface. This locks in the structured error class so the migration
      // to FetchError can't silently regress to a bare Error. `checkForUpdate`
      // catches the error and converts to UpdateInfo, so we exercise the
      // exported `fetchLatestFromNpm` directly to see the raw FetchError.
      const fe = await expectFetchError(() => fetchLatestFromNpm(), {
        status: 404,
        context: {
          op: 'checkForUpdate',
          registry: 'npmjs',
          url: 'https://registry.npmjs.org/wrongstack/latest',
        },
      });
      expect(fe).toBeDefined();
    });

    it('non-2xx npm response includes the failing status in the FetchError', async () => {
      // A second test covers a different status code to make sure the
      // status flows through (not just hardcoded to 404). 500 surfaces the
      // difference between transport (transient) and protocol (permanent).
      const fe = await expectFetchError(() => fetchLatestFromNpm(), {
        status: 500,
        // No context shape asserted — just verify the status flows through.
      });
      expect(fe.status).toBe(500);
    });
  });

  // ──────────────────────────────────────────── cache behavior

  describe('cache behavior', () => {
    it('uses a fresh cache on second call without network', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '1.0.0' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      expect((await checkForUpdate(undefined, () => userHome)).latest).toBe('1.0.0');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      const cached = await checkForUpdate(undefined, () => userHome);
      expect(cached.checkFailed).toBe(false);
      expect(cached.latest).toBe('1.0.0');
    });

    it('forceRefresh bypasses fresh cache and marks stale fallback as failed', async () => {
      const cacheFile = path.join(
        userHome,
        '.wrongstack',
        'profiles',
        'default',
        'update-cache.json',
      );
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          timestamp: Date.now(),
          latestVersion: '1.0.0',
          packageName: 'wrongstack',
        }),
      );
      const failingFetch = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', failingFetch);

      const info = await checkForUpdate({ homeFn: () => userHome, forceRefresh: true });

      expect(failingFetch).toHaveBeenCalledOnce();
      expect(info.latest).toBe('1.0.0');
      expect(info.checkFailed).toBe(true);
    });

    it('ignores malformed cache data without throwing', async () => {
      const cacheFile = path.join(
        userHome,
        '.wrongstack',
        'profiles',
        'default',
        'update-cache.json',
      );
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ timestamp: 'tomorrow', latestVersion: {} }));
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      await expect(checkForUpdate(undefined, () => userHome)).resolves.toMatchObject({
        checkFailed: true,
        outdated: false,
      });
    });
  });

  describe('registry transport', () => {
    it('uses the encoded scoped package endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '1.2.3' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      expect(await fetchLatestFromNpm('@wrongstack/cli')).toBe('1.2.3');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/%40wrongstack%2Fcli/latest',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('honors a caller abort signal through response-body parsing', async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              if (init?.signal?.aborted) {
                reject(init.signal.reason);
                return;
              }
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        })),
      );

      const pending = fetchLatestFromNpm('wrongstack', 30_000, controller.signal);
      controller.abort(new Error('caller cancelled'));

      await expect(pending).rejects.toThrow('caller cancelled');
    });
  });

  // ───────────────────────────────────────────────────────────── getUpdateNotification

  describe('getUpdateNotification()', () => {
    it('returns null when on latest version', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: currentVersion() }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const note = await getUpdateNotification(undefined, () => userHome);
      expect(note).toBeNull();
    });

    it('returns notification string when outdated', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '999.0.0' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const note = await getUpdateNotification(undefined, () => userHome);
      expect(note).not.toBeNull();
      expect(note).toContain('Update available:');
    });
  });

  // ──────────────────────────────────────────────────── semver edge cases

  describe('semver comparison', () => {
    it('orders prereleases below the corresponding stable release', () => {
      expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true);
      expect(isNewer('1.0.0-beta.2', '1.0.0-beta.10')).toBe(false);
      expect(isNewer('1.0.0-beta.10', '1.0.0-beta.2')).toBe(true);
    });

    it('rejects invalid registry versions', () => {
      expect(isNewer('latest', '1.0.0')).toBe(false);
    });

    it('handles versions with v prefix from npm', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: 'v1.0.0' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const info = await checkForUpdate(undefined, () => userHome);
      expect(info.latest).toBe('v1.0.0');
    });
  });
});
