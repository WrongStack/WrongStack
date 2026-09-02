import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cw from '../../src/coordination/checkpoint-wiring.js';
import type { DirectorCheckpointHost } from '../../src/coordination/checkpoint-wiring.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-wiring-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeHost(over: Partial<DirectorCheckpointHost> = {}): DirectorCheckpointHost {
  return {
    id: 'dir-1',
    manifestPath: path.join(tmp, 'manifest.json'),
    manifestDebounceMs: -1,
    stateCheckpoint: null,
    sessionWriter: null,
    usage: { snapshot: () => ({ total: { cost: 0 } }) },
    manifestEntries: new Map(),
    completed: new Map(),
    logShutdownError: vi.fn(),
    ...over,
  } as DirectorCheckpointHost;
}

const okResult = (taskId: string): TaskResult => ({
  subagentId: 's',
  taskId,
  status: 'success',
  iterations: 2,
  toolCalls: 3,
  durationMs: 4,
});

describe('appendSessionEvent', () => {
  it('is a no-op without a session writer', async () => {
    await expect(
      cw.appendSessionEvent(makeHost(), { type: 'x' } as never),
    ).resolves.toBeUndefined();
  });
  it('appends through the writer and swallows writer errors', async () => {
    const append = vi.fn(async () => {});
    await cw.appendSessionEvent(makeHost({ sessionWriter: { append } as never }), {
      type: 'x',
    } as never);
    expect(append).toHaveBeenCalled();
    const throwing = vi.fn(async () => {
      throw new Error('handle closed');
    });
    await expect(
      cw.appendSessionEvent(makeHost({ sessionWriter: { append: throwing } as never }), {
        type: 'y',
      } as never),
    ).resolves.toBeUndefined();
  });
});

describe('writeManifest', () => {
  it('returns null when no manifest path is configured', async () => {
    expect(await cw.writeManifest(makeHost({ manifestPath: undefined }))).toBeNull();
  });

  it('writes a manifest with per-task results (completed + pending)', async () => {
    const host = makeHost();
    host.manifestEntries.set('sub-1', { subagentId: 'sub-1', taskIds: ['t1', 't2'] });
    host.completed.set('t1', okResult('t1')); // t2 has no result → pending row
    const written = await cw.writeManifest(host);
    expect(written).toBe(host.manifestPath);
    const json = JSON.parse(await fs.readFile(host.manifestPath!, 'utf8'));
    expect(json.directorRunId).toBe('dir-1');
    const child = json.children[0];
    expect(child.results).toEqual([
      { taskId: 't1', status: 'success', iterations: 2, toolCalls: 3, durationMs: 4 },
      { taskId: 't2', status: 'pending' },
    ]);
  });
});

describe('scheduleManifest', () => {
  it('returns null when there is no path or debounce is negative', () => {
    expect(cw.scheduleManifest(makeHost({ manifestPath: undefined }))).toBeNull();
    expect(cw.scheduleManifest(makeHost({ manifestDebounceMs: -1 }))).toBeNull();
  });

  it('writes synchronously (no timer) when debounce is 0', async () => {
    const host = makeHost({ manifestDebounceMs: 0 });
    host.manifestEntries.set('s', { taskIds: [] });
    expect(cw.scheduleManifest(host)).toBeNull();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(host.manifestPath!, 'utf8')).directorRunId).toBe('dir-1');
    });
  });

  it('schedules a debounced timer that writes the manifest', async () => {
    const host = makeHost({ manifestDebounceMs: 5 });
    host.manifestEntries.set('s', { taskIds: [] });
    const handle = cw.scheduleManifest(host);
    expect(handle).not.toBeNull();
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(host.manifestPath!, 'utf8')).directorRunId).toBe('dir-1');
    });
    clearTimeout(handle!);
  });

  it('routes a synchronous-write failure to logShutdownError', async () => {
    // Parent is a FILE → mkdir(dirname) fails → writeManifest rejects.
    const filePath = path.join(tmp, 'blocker');
    await fs.writeFile(filePath, 'x');
    const logShutdownError = vi.fn();
    const host = makeHost({
      manifestDebounceMs: 0,
      manifestPath: path.join(filePath, 'manifest.json'),
      logShutdownError,
    });
    cw.scheduleManifest(host);
    await vi.waitFor(() =>
      expect(logShutdownError).toHaveBeenCalledWith('manifest_write_debounced', expect.anything()),
    );
  });

  it('routes a debounced-write failure to logShutdownError', async () => {
    const filePath = path.join(tmp, 'blocker2');
    await fs.writeFile(filePath, 'x');
    const logShutdownError = vi.fn();
    const host = makeHost({
      manifestDebounceMs: 5,
      manifestPath: path.join(filePath, 'manifest.json'),
      logShutdownError,
    });
    const handle = cw.scheduleManifest(host);
    await vi.waitFor(() =>
      expect(logShutdownError).toHaveBeenCalledWith('manifest_write_debounced', expect.anything()),
    );
    clearTimeout(handle!);
  });
});

describe('checkpoint state helpers', () => {
  it('setCheckpointState / resumeFromCheckpoint delegate to the checkpoint and no-op without one', () => {
    const resume = vi.fn();
    cw.setCheckpointState(makeHost({ stateCheckpoint: { resume } as never }), { foo: 1 } as never);
    cw.resumeFromCheckpoint(makeHost({ stateCheckpoint: { resume } as never }), {
      foo: 1,
    } as never);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(() => cw.setCheckpointState(makeHost(), {} as never)).not.toThrow();
    expect(() => cw.resumeFromCheckpoint(makeHost(), {} as never)).not.toThrow();
  });

  it('acquireCheckpointLock delegates, and returns true without a checkpoint', async () => {
    expect(await cw.acquireCheckpointLock(makeHost())).toBe(true);
    const acquireLock = vi.fn().mockResolvedValue(false);
    expect(
      await cw.acquireCheckpointLock(makeHost({ stateCheckpoint: { acquireLock } as never })),
    ).toBe(false);
  });
});
