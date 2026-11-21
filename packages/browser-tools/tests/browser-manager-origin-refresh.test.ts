import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BrowserLauncher, BrowserSessionManager } from '../src/manager.js';
import { browserPrivateOrigins } from '../src/policy.js';

/**
 * Regression (2026-10-20 session): /browser allow ran in another process (the
 * TUI host) and wrote browser-policy.json, but a browser manager created
 * before the allowance kept refusing the origin — the policy was treated as a
 * startup snapshot. The policy layer must re-read the file on the next call
 * and splice the refresh into the SAME live array the manager and its network
 * proxy already hold, so an existing manager honors a newly allowed origin
 * without a restart.
 */
let root: string;
beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
  root = await mkdtemp(join(tmpdir(), 'browser-origin-refresh-'));
  vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('BrowserSessionManager origin policy refresh', () => {
  it('honors an origin allowed externally after the manager was created', async () => {
    const url = 'http://127.0.0.1:51175/';
    // Warm the live cache the way managerFor does on the first tool call.
    const origins = browserPrivateOrigins(root);
    expect(origins).toEqual([]);

    // Existing manager: holds the live array by reference, never re-created.
    const launcher: BrowserLauncher = vi.fn(async () => {
      throw new Error('LAUNCH_SENTINEL');
    });
    const manager = new BrowserSessionManager(
      { artifactRoot: join(root, 'artifacts'), allowedPrivateOrigins: origins },
      launcher,
    );
    const signal = new AbortController().signal;

    // Before the allowance the guard denies before any launch attempt.
    await expect(manager.open('tester', { url }, signal)).rejects.toThrow('/browser allow');
    expect(launcher).not.toHaveBeenCalled();

    // Another process (the TUI next to this agent) persists the allowance by
    // writing the policy file directly — no in-process setter involved.
    const projectDir = resolveWstackPaths({ projectRoot: root }).projectDir;
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'browser-policy.json'),
      JSON.stringify({ privateOrigins: ['http://127.0.0.1:51175'] }),
    );

    // Next tool call: managerFor re-reads the policy; the live array is
    // refreshed IN PLACE, so the existing manager (and its proxy) sees it.
    const refreshed = browserPrivateOrigins(root);
    expect(refreshed).toContain('http://127.0.0.1:51175');
    expect(refreshed).toBe(origins);

    // The SAME manager now passes the guard and proceeds to launch — the
    // sentinel proves the origin check no longer refuses.
    await expect(manager.open('tester', { url }, signal)).rejects.toThrow('LAUNCH_SENTINEL');
  });
});
