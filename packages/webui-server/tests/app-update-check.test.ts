import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAppUpdateCheck,
  isNewerVersion,
  RELEASES_LATEST_URL,
} from '../src/server/app-update-check.js';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cacheFile(content?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-update-'));
  dirs.push(dir);
  const file = path.join(dir, 'profile', 'update-cache.json');
  if (content) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }
  return file;
}

const release = (tag: string) =>
  vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify({ tag_name: tag }), { status: 200 }),
  );

describe('app update check', () => {
  it('compares versions as releases do', () => {
    expect(isNewerVersion('1.5.3', '1.5.2')).toBe(true);
    expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.5.2', '1.5.2')).toBe(false);
    expect(isNewerVersion('1.5.1', '1.5.2')).toBe(false);
    expect(isNewerVersion('1.5.2', '1.5.2-rc.1')).toBe(true);
    expect(isNewerVersion('1.5.2-rc.2', '1.5.2-rc.10')).toBe(false);
    expect(isNewerVersion('dev', '1.5.2')).toBe(false);
  });

  it('asks GitHub once, reports a newer release and shares the answer through the CLI cache', async () => {
    const file = cacheFile();
    const fetchImpl = release('v1.5.3');
    const check = createAppUpdateCheck({
      currentVersion: '1.5.2',
      cacheFile: file,
      fetchImpl,
      now: () => 10 * DAY,
    });
    expect(check.info()).toEqual({
      appVersion: '1.5.2',
      updateAvailable: false,
      updateCheckFailed: false,
    });
    await check.refresh();
    await check.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(RELEASES_LATEST_URL);
    expect(check.info()).toEqual({
      appVersion: '1.5.2',
      latestVersion: '1.5.3',
      updateAvailable: true,
      updateCheckFailed: false,
    });
    // The CLI's standalone-binary cache entry: `wstack update` and the engine read one answer.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      timestamp: 10 * DAY,
      latestVersion: '1.5.3',
      packageName: 'standalone-binary',
    });
  });

  it('answers from a fresh cache without asking, and asks again once it is a day old', async () => {
    const file = cacheFile({
      timestamp: 5 * DAY,
      latestVersion: '1.5.2',
      packageName: 'standalone-binary',
    });
    let now = 5 * DAY + 1000;
    const fetchImpl = release('1.6.0');
    const check = createAppUpdateCheck({
      currentVersion: '1.5.2',
      cacheFile: file,
      fetchImpl,
      now: () => now,
    });
    await check.refresh();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(check.info()).toMatchObject({ latestVersion: '1.5.2', updateAvailable: false });

    now = 6 * DAY + 1;
    await check.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(check.info()).toMatchObject({ latestVersion: '1.6.0', updateAvailable: true });
  });

  it('keeps the cached answer and says the check failed when GitHub cannot be reached', async () => {
    const file = cacheFile({
      timestamp: 0,
      latestVersion: '1.5.3',
      packageName: 'standalone-binary',
    });
    const check = createAppUpdateCheck({
      currentVersion: '1.5.2',
      cacheFile: file,
      fetchImpl: vi.fn(async () => new Response('busy', { status: 503 })),
      now: () => 3 * DAY,
    });
    await check.refresh();
    expect(check.info()).toEqual({
      appVersion: '1.5.2',
      latestVersion: '1.5.3',
      updateAvailable: true,
      updateCheckFailed: true,
    });
  });

  it('ignores an npm package entry in the cache: the executable updates from GitHub', async () => {
    const file = cacheFile({ timestamp: 0, latestVersion: '9.0.0', packageName: 'wrongstack' });
    const check = createAppUpdateCheck({
      currentVersion: '1.5.2',
      cacheFile: file,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }),
      now: () => 1,
    });
    expect(check.info().latestVersion).toBeUndefined();
    await check.refresh();
    expect(check.info()).toMatchObject({ updateAvailable: false, updateCheckFailed: true });
  });

  it("answers /tuneup's version line in the CLI's update shape", async () => {
    const check = createAppUpdateCheck({
      currentVersion: '1.5.2',
      cacheFile: cacheFile(),
      fetchImpl: release('1.5.3'),
      now: () => 1,
    });
    expect(await check.tuneupInfo()).toEqual({
      current: '1.5.2',
      latest: '1.5.3',
      outdated: true,
      checkFailed: false,
    });
  });
});
