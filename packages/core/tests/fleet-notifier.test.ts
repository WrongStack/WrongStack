import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetNotifier } from '../src/coordination/fleet-notifier.js';

const INSTANCES_FILE = 'webui-instances.json';

let tmp = '';
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleetnotifier-'));
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
});

afterEach(async () => {
  killSpy.mockRestore();
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeInstances(records: object[]) {
  await fs.writeFile(path.join(tmp, INSTANCES_FILE), JSON.stringify({ instances: records }));
}

describe('FleetNotifier.discover / endpoints', () => {
  it('returns ping URLs for same-project, live, non-self instances', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp }, // valid
      { pid: 123, httpPort: 7002, host: '0.0.0.0', projectRoot: tmp }, // host remapped
      { pid: 124, httpPort: 7003, host: '::', projectRoot: tmp }, // host remapped
      { pid: 125, httpPort: 7004, host: '', projectRoot: tmp }, // host default
      { pid: 999, httpPort: 7005, host: '127.0.0.1', projectRoot: tmp }, // selfPid excluded
      { pid: 126, httpPort: 7006, host: '127.0.0.1', projectRoot: '/other/project' }, // other project
      { pid: 127, host: '127.0.0.1', projectRoot: tmp }, // no httpPort
      { pid: 'x', httpPort: 7008, host: '127.0.0.1', projectRoot: tmp }, // non-integer pid -> pidAlive false
    ]);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
    const urls = await n.endpoints();
    expect(urls).toEqual([
      'http://127.0.0.1:7001/api/fleet/ping',
      'http://127.0.0.1:7002/api/fleet/ping',
      'http://127.0.0.1:7003/api/fleet/ping',
      'http://127.0.0.1:7004/api/fleet/ping',
    ]);
  });

  it('excludes dead pids (ESRCH)', async () => {
    killSpy.mockImplementation((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as never);
    await writeInstances([{ pid: 4242, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp }]);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
    expect(await n.endpoints()).toEqual([]);
  });

  it('treats EPERM (no permission to signal) as alive', async () => {
    killSpy.mockImplementation((() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }) as never);
    await writeInstances([{ pid: 555, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp }]);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
    expect(await n.endpoints()).toEqual(['http://127.0.0.1:7001/api/fleet/ping']);
  });

  it('returns [] for a missing or corrupt instances file', async () => {
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp });
    expect(await n.endpoints()).toEqual([]); // no file
    await fs.writeFile(path.join(tmp, INSTANCES_FILE), '{ not json');
    const n2 = new FleetNotifier({ baseDir: tmp, projectRoot: tmp });
    expect(await n2.endpoints()).toEqual([]); // corrupt
  });

  it('treats a non-array instances field as empty', async () => {
    await fs.writeFile(path.join(tmp, INSTANCES_FILE), JSON.stringify({ instances: 'nope' }));
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp });
    expect(await n.endpoints()).toEqual([]);
  });

  it('normalises project roots case-sensitively on POSIX', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      await writeInstances([
        { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
      ]);
      const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
      expect(await n.endpoints()).toEqual(['http://127.0.0.1:7001/api/fleet/ping']);
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });

  it('caches discovery within the TTL and re-reads after it', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
    const first = await n.endpoints();
    // Mutate the file; cached result must be unchanged within TTL.
    await writeInstances([
      { pid: process.pid, httpPort: 9009, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const cached = await n.endpoints();
    expect(cached).toEqual(first);
    // Past the TTL -> re-discover.
    await vi.advanceTimersByTimeAsync(3_000);
    const refreshed = await n.endpoints();
    expect(refreshed).toEqual(['http://127.0.0.1:9009/api/fleet/ping']);
  });

  it('re-scopes and invalidates discovery cache after a project switch', async () => {
    const nextProject = path.join(tmp, 'next-project');
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
      { pid: process.pid, httpPort: 7002, host: '127.0.0.1', projectRoot: nextProject },
    ]);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });

    expect(await n.endpoints()).toEqual(['http://127.0.0.1:7001/api/fleet/ping']);
    n.setProjectRoot(nextProject);
    expect(await n.endpoints()).toEqual(['http://127.0.0.1:7002/api/fleet/ping']);
  });
});

describe('FleetNotifier.notify / flush / dispose', () => {
  it('coalesces bursts into a single flush', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const post = vi.fn(async () => undefined);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999, post });
    await n.endpoints(); // warm discovery cache so flush avoids real I/O under fake timers
    n.notify();
    n.notify(); // timer already armed -> noop
    n.notify();
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50); // COALESCE_MS
    expect(post).toHaveBeenCalledTimes(1);
    // Second arg is the target's API token (H3) — undefined for a record that
    // predates it, which the target will then reject. Best-effort by design.
    expect(post).toHaveBeenCalledWith('http://127.0.0.1:7001/api/fleet/ping', undefined);
  });

  it('forwards the target instance token recorded in the registry (H3)', async () => {
    await writeInstances([
      {
        pid: process.pid,
        httpPort: 7001,
        host: '127.0.0.1',
        projectRoot: tmp,
        authToken: 'tok-abc',
      },
    ]);
    const post = vi.fn(async () => undefined);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999, post });
    await n.endpoints();
    n.notify();
    await vi.advanceTimersByTimeAsync(50);
    expect(post).toHaveBeenCalledWith('http://127.0.0.1:7001/api/fleet/ping', 'tok-abc');
  });

  it('swallows a rejecting POST (best-effort)', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const post = vi.fn(async () => {
      throw new Error('boom');
    });
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999, post });
    await n.endpoints(); // warm cache
    n.notify();
    await vi.advanceTimersByTimeAsync(50); // flush -> doPost.reject -> .catch
    expect(post).toHaveBeenCalled();
  });

  it('uses defaultPost (fetch) when no post is injected', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999 });
    await n.endpoints(); // warm cache
    n.notify();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7001/api/fleet/ping',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('does nothing after dispose()', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const post = vi.fn(async () => undefined);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999, post });
    n.dispose();
    n.notify(); // disposed -> noop
    await vi.advanceTimersByTimeAsync(50);
    expect(post).not.toHaveBeenCalled();
  });

  it('clears an armed coalesce timer on dispose', async () => {
    await writeInstances([
      { pid: process.pid, httpPort: 7001, host: '127.0.0.1', projectRoot: tmp },
    ]);
    const post = vi.fn(async () => undefined);
    const n = new FleetNotifier({ baseDir: tmp, projectRoot: tmp, selfPid: 999, post });
    await n.endpoints();
    n.notify(); // arm the coalesce timer
    n.dispose(); // dispose while armed -> clearTimeout + null
    await vi.advanceTimersByTimeAsync(50);
    expect(post).not.toHaveBeenCalled();
  });
});
