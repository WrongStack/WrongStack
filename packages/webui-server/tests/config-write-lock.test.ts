/**
 * Regression for G6 (RACE-003): the previous `updateGlobalConfig`
 * chained writes through an in-process Promise lock, so a concurrent
 * write from a second process (a TUI running alongside the WebUI
 * server, or two WebUI processes spawned by mistake) could read the
 * same pre-change snapshot and silently revert the first writer's
 * edit. The fix routes the read-modify-write cycle through
 * `withFileLock`; two writers that race against the same file now
 * serialise on the lock and the second writer sees the first
 * writer's post-write state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLock } from '@wrongstack/core/utils';
import { updateGlobalConfig } from '../src/server/pref-helpers.js';
import { createTestVault } from './pref-helpers-test-helpers.js';

describe('G6 / updateGlobalConfig — cross-process serialisation', () => {
  let tmpDir: string;
  let configPath: string;
  let vault: ReturnType<typeof createTestVault>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g6-config-lock-'));
    configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ yolo: true }));
    vault = createTestVault();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('waits for an external lock holder before reading', async () => {
    // Acquire the file lock from "another process". The helper
    // must block until the holder releases — if it raced past the
    // lock it would overwrite the holder's write.
    const externalRelease = await withFileLock(
      configPath,
      () => new Promise<void>((r) => setTimeout(r, 200)),
    );
    const start = Date.now();
    const writeDone = updateGlobalConfig(
      { profileConfigPath: configPath, vault, logger: { warn: () => undefined } },
      { lock: Promise.resolve() },
      (cfg) => {
        cfg['yolo'] = false;
      },
      'g6-test',
    );
    // The helper is now blocked on the external lock; release it
    // mid-flight so the assertion below has a deterministic
    // observable transition.
    setTimeout(() => externalRelease(undefined), 120);
    await writeDone;
    const elapsed = Date.now() - start;
    // Must have waited for the external holder — at least ~100ms.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    // The write must have taken effect after the lock cleared.
    const after = JSON.parse(await fs.readFile(configPath, 'utf8')) as { yolo?: boolean };
    expect(after.yolo).toBe(false);
  });
});
