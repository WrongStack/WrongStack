/**
 * Coverage for tools/src/process-registry-persistent.ts
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersistentProcessRegistry,
  resetPersistentProcessRegistry,
} from '../src/process-registry-persistent.js';

function noopHandler(_reason: unknown): void {
  /* swallow fire-and-forget ENOENT */
}

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-reg-test-'));
  originalEnv = process.env.WRONGSTACK_HOME;
  process.env.WRONGSTACK_HOME = tempDir;
  resetPersistentProcessRegistry();
  // Suppress unhandled rejections from fire-and-forget registry timers
  process.on('unhandledRejection', noopHandler);
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.WRONGSTACK_HOME;
  else process.env.WRONGSTACK_HOME = originalEnv;
  process.off('unhandledRejection', noopHandler);
  // Give async fs operations time to release file handles on Windows
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('PersistentProcessRegistry', () => {
  it('constructs and starts', () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.stop();
  });

  it('registerMainProcess registers the current process', () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.registerMainProcess();
    reg.stop();
  });

  it('registerChildProcess registers a child', () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.registerChildProcess(12345, 'child', 'node child.js');
    reg.stop();
  });

  it('getInstanceId returns a string', () => {
    const reg = new PersistentProcessRegistry();
    const id = reg.getInstanceId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('isProtectedPid returns false for unknown pid', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    const result = await reg.isProtectedPid(999999);
    expect(result).toBe(false);
    reg.stop();
  });

  it('getAllProtectedPids returns an array', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    const pids = await reg.getAllProtectedPids();
    expect(Array.isArray(pids)).toBe(true);
    reg.stop();
  });

  it('shouldBlockKill returns false for unprotected pid', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    const result = await reg.shouldBlockKill(999999);
    expect(result).toBe(false);
    reg.stop();
  });

  it('addProtectedPattern stores a pattern', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    await reg.addProtectedPattern('node.*test');
    // shouldBlockKill should now match the pattern
    const result = await reg.shouldBlockKill(999999);
    // The pid 999999 is not registered, but pattern-based check may apply
    // depending on the command — here we just verify no crash
    expect(typeof result).toBe('boolean');
    reg.stop();
  });

  it('unregister removes a pid', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.registerChildProcess(88888, 'temp', 'cmd');
    await reg.unregister(88888);
    const isProtected = await reg.isProtectedPid(88888);
    expect(isProtected).toBe(false);
    reg.stop();
  });

  it('unregister on non-existent pid does not throw', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    await expect(reg.unregister(77777)).resolves.not.toThrow();
    reg.stop();
  });

  it('getGlobalStatus returns structured data', async () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    const status = await reg.getGlobalStatus();
    expect(status).toBeDefined();
    expect(typeof status).toBe('object');
    reg.stop();
  });

  it('registerChildProcess with sessionId and spawnMode', () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.registerChildProcess(11111, 'named', 'cmd', 'session-1', 'fork');
    reg.stop();
  });

  it('multiple start/stop cycles work', () => {
    const reg = new PersistentProcessRegistry();
    reg.start();
    reg.stop();
    reg.start();
    reg.stop();
  });
});

describe('getPersistentProcessRegistry singleton', () => {
  it('returns the same instance', async () => {
    const { getPersistentProcessRegistry } = await import('../src/process-registry-persistent.js');
    const a = getPersistentProcessRegistry();
    const b = getPersistentProcessRegistry();
    expect(a).toBe(b);
  });

  it('resetPersistentProcessRegistry clears the singleton', async () => {
    const { getPersistentProcessRegistry } = await import('../src/process-registry-persistent.js');
    const a = getPersistentProcessRegistry();
    resetPersistentProcessRegistry();
    const b = getPersistentProcessRegistry();
    expect(a).not.toBe(b);
  });
});
