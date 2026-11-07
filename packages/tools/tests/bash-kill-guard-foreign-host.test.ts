import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAndBlockKillCommand } from '../src/bash-kill-guard.js';

// PIDs and process names are host-local. On a shared home directory (NFS,
// roaming profile) several machines write the same registry file: a foreign
// entry must never make a local name-based kill look protected.

let home: string;
let originalHome: string | undefined;
const isWin = process.platform === 'win32';
const nameCommand = (name: string) => (isWin ? `taskkill /IM ${name}` : `pkill ${name}`);

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kill-guard-host-'));
  originalHome = process.env['WRONGSTACK_HOME'];
  process.env['WRONGSTACK_HOME'] = home;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = originalHome;
  await fs.rm(home, { recursive: true, force: true });
});

type Entry = Record<string, unknown>;
function entry(hostname: string | undefined, name: string): Entry {
  const now = Date.now();
  return {
    pid: 999_999,
    name,
    command: 'node worker.js',
    startedAt: now,
    lastHeartbeat: now,
    instanceId: `instance-${hostname ?? 'legacy'}`,
    ...(hostname === undefined ? {} : { hostname }),
    protected: true,
    spawnMode: 'spawn',
    platform: process.platform,
  };
}

async function writeRegistry(entries: Array<[string, Entry]>): Promise<void> {
  await fs.writeFile(
    path.join(home, 'process-registry.json'),
    JSON.stringify({
      version: 1,
      instances: entries,
      protectedPatterns: ['wrongstack', 'node'],
      lastCleanup: Date.now(),
    }),
  );
}

const blocked = async (command: string) => (await checkAndBlockKillCommand(command)).blocked;

describe('kill guard registry host identity', () => {
  it('ignores another host’s entry when matching a name', async () => {
    await writeRegistry([['some-other-machine:999999', entry('some-other-machine', 'builder')]]);
    await expect(blocked(nameCommand('builder'))).resolves.toBe(false);
  });

  it('still blocks a local entry by name, including a legacy one without a hostname', async () => {
    await writeRegistry([[`${os.hostname()}:999999`, entry(os.hostname(), 'builder')]]);
    await expect(blocked(nameCommand('builder'))).resolves.toBe(true);

    await writeRegistry([['999999', entry(undefined, 'builder')]]);
    await expect(blocked(nameCommand('builder'))).resolves.toBe(true);
  });

  it('keeps a local name protected while ignoring a foreign name', async () => {
    await writeRegistry([
      [`${os.hostname()}:999999`, entry(os.hostname(), 'worker')],
      ['some-other-machine:999998', entry('some-other-machine', 'builder')],
    ]);
    await expect(blocked(nameCommand('worker'))).resolves.toBe(true);
    await expect(blocked(nameCommand('builder'))).resolves.toBe(false);
  });

  it('keeps the literal wrongstack name protected regardless of the registry', async () => {
    await writeRegistry([['some-other-machine:999999', entry('some-other-machine', 'builder')]]);
    await expect(blocked(nameCommand('wrongstack'))).resolves.toBe(true);
  });
});
