import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PersistentProcessEntry,
  PersistentProcessRegistry,
  registryEntryKey,
} from '../src/process-registry-persistent.js';

// PIDs are host-local. On a shared home directory (NFS, roaming profile)
// several machines write the same registry file, so an entry must only answer
// protection queries for the host that wrote it — and a same-numbered process
// on another host must not replace this host's entry.

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-registry-host-'));
  originalHome = process.env['WRONGSTACK_HOME'];
  process.env['WRONGSTACK_HOME'] = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = originalHome;
  await fs.rm(home, { recursive: true, force: true });
});

const registryFile = () => path.join(home, 'process-registry.json');

function entry(hostname: string | undefined, pid: number): PersistentProcessEntry {
  const now = Date.now();
  return {
    pid,
    name: 'worker',
    command: 'node -e setInterval',
    startedAt: now,
    lastHeartbeat: now,
    instanceId: `instance-${hostname ?? 'legacy'}`,
    ...(hostname === undefined ? {} : { hostname }),
    protected: true,
    spawnMode: 'spawn',
    platform: process.platform,
  } as PersistentProcessEntry;
}

async function writeRegistry(entries: Array<[string, PersistentProcessEntry]>): Promise<void> {
  await fs.writeFile(
    registryFile(),
    JSON.stringify({
      version: 1,
      instances: entries,
      protectedPatterns: [],
      lastCleanup: Date.now(),
    }),
  );
}

describe('persistent registry host identity', () => {
  it('keys entries by host and pid, not by pid alone', () => {
    expect(registryEntryKey('host-a', 42)).toBe('host-a:42');
    expect(registryEntryKey('host-a', 42)).not.toBe(registryEntryKey('host-b', 42));
  });

  it('ignores another host’s entry for a local pid', async () => {
    const pid = 4242;
    await writeRegistry([['other-host:4242', entry('other-host', pid)]]);
    const registry = new PersistentProcessRegistry();
    await expect(registry.shouldBlockKill(pid)).resolves.toBe(false);
    await expect(registry.isProtectedPid(pid)).resolves.toBe(false);
    await expect(registry.getAllProtectedPids()).resolves.toEqual([]);
  });

  it('still protects a local entry, including a legacy one without a hostname', async () => {
    const pid = 4343;
    await writeRegistry([[`${os.hostname()}:4343`, entry(os.hostname(), pid)]]);
    const registry = new PersistentProcessRegistry();
    await expect(registry.shouldBlockKill(pid)).resolves.toBe(true);

    await writeRegistry([['4343', entry(undefined, pid)]]);
    await expect(new PersistentProcessRegistry().shouldBlockKill(pid)).resolves.toBe(true);
  });

  it('unregister removes only this host’s entry', async () => {
    const pid = 4444;
    await writeRegistry([
      [`${os.hostname()}:4444`, entry(os.hostname(), pid)],
      ['other-host:4444', entry('other-host', pid)],
    ]);
    await new PersistentProcessRegistry().unregister(pid);
    const written = JSON.parse(await fs.readFile(registryFile(), 'utf8')) as {
      instances: Array<[string, PersistentProcessEntry]>;
    };
    expect(written.instances.map(([key]) => key)).toEqual(['other-host:4444']);
  });
});
