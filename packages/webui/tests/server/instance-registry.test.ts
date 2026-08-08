import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type WebUIInstanceRecord,
  formatInstances,
  isPidAlive,
  listInstances,
  registerInstance,
  registryPath,
  unregisterInstance,
} from '@wrongstack/webui-server';

let baseDir: string;

function record(over: Partial<WebUIInstanceRecord> = {}): WebUIInstanceRecord {
  return {
    pid: process.pid, // current process is guaranteed alive
    httpPort: 3456,
    host: '127.0.0.1',
    projectRoot: '/tmp/proj-a',
    projectName: 'proj-a',
    startedAt: '2026-01-01T00:00:00.000Z',
    url: 'http://127.0.0.1:3456',
    ...over,
    surface: over.surface ?? 'webui',
  };
}

/** A pid that is almost certainly not a live process. */
const DEAD_PID = 2147483600;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-registry-'));
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for an unused pid and invalid pids', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe('register / list / unregister', () => {
  it('registers an instance and lists it back', async () => {
    await registerInstance(record({ httpPort: 3466 }), baseDir);
    const list = await listInstances(baseDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ httpPort: 3466, pid: process.pid });
    // File lives where the user expects it.
    const raw = await fs.readFile(registryPath(baseDir), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it('keeps optional multi-session child metadata backward-compatible in version 1 files', async () => {
    await registerInstance(
      record({
        role: 'session-child',
        sessionId: 'sess-a',
        parentPid: 123,
        parentShellId: 'shell-a',
        runtimeId: 'runtime-a',
        attachable: true,
        auth: { scheme: 'registry-token', tokenPresent: true },
        lastReadyAt: '2026-01-01T00:00:01.000Z',
        protocolVersion: 1,
        capabilities: ['multi-session-child'],
      }),
      baseDir,
    );

    const list = await listInstances(baseDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      role: 'session-child',
      sessionId: 'sess-a',
      parentPid: 123,
      parentShellId: 'shell-a',
      runtimeId: 'runtime-a',
      attachable: true,
      auth: { scheme: 'registry-token', tokenPresent: true },
      lastReadyAt: '2026-01-01T00:00:01.000Z',
      protocolVersion: 1,
      capabilities: ['multi-session-child'],
    });
    const raw = await fs.readFile(registryPath(baseDir), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it('replaces a stale entry for the same pid instead of duplicating', async () => {
    await registerInstance(record({ httpPort: 3456 }), baseDir);
    await registerInstance(record({ httpPort: 9999 }), baseDir);
    const list = await listInstances(baseDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.httpPort).toBe(9999);
  });

  it('prunes dead-pid entries on register and on list', async () => {
    // Seed the file directly with a dead instance.
    await fs.writeFile(
      registryPath(baseDir),
      JSON.stringify({
        version: 1,
        instances: [record({ pid: DEAD_PID, projectName: 'ghost' })],
      }),
    );
    // A live register should drop the ghost and keep only the live one.
    await registerInstance(record({ projectName: 'live' }), baseDir);
    const list = await listInstances(baseDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.projectName).toBe('live');
  });

  it('unregisters by pid', async () => {
    await registerInstance(record(), baseDir);
    await unregisterInstance(process.pid, baseDir);
    expect(await listInstances(baseDir)).toHaveLength(0);
  });

  it('treats a missing/corrupt file as empty', async () => {
    expect(await listInstances(baseDir)).toEqual([]);
    await fs.writeFile(registryPath(baseDir), 'not json{');
    expect(await listInstances(baseDir)).toEqual([]);
  });
});

describe('formatInstances', () => {
  it('reports an empty registry clearly', () => {
    expect(formatInstances([])).toMatch(/No WebUI instances/i);
  });
  it('lists ports, pid, and project path', () => {
    const out = formatInstances([
      record({ httpPort: 3466, projectName: 'proj-b', url: 'http://127.0.0.1:3466' }),
    ]);
    expect(out).toContain('3466');
    expect(out).toContain('proj-b');
    expect(out).toContain(String(process.pid));
  });
});
