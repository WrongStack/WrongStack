import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionPersistence } from '@wrongstack/acp/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpSessionPersistence } from '../src/subcommands/handlers/acp-server.js';

type SessionState = Parameters<SessionPersistence['save']>[0];

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function mkTempRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-persist-'));
  cleanup.push(dir);
  return dir;
}

describe('createAcpSessionPersistence (cross-cwd session/load)', () => {
  it('saves under the session cwd and loads it even when a later server spawns from a different directory', async () => {
    const root = await mkTempRoot();
    const homeStoreDir = path.join(root, 'stores', 'home');
    const projectAStoreDir = path.join(root, 'stores', 'project-a');
    const projectBStoreDir = path.join(root, 'stores', 'project-b');
    const projectBCwd = path.join(root, 'work', 'project-b');
    await fsp.mkdir(projectBCwd, { recursive: true });

    const resolveDir = (cwd: string): string =>
      path.resolve(cwd) === path.resolve(projectBCwd) ? projectBStoreDir : projectAStoreDir;

    // Server 1 starts in $HOME, client opens a session in projectB.
    const first = createAcpSessionPersistence(homeStoreDir, resolveDir);
    const state: SessionState = {
      id: 'sess_cross_1',
      cwd: projectBCwd,
      abort: new AbortController(),
      modeId: 'code',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:01:00.000Z',
      title: 'Cross-cwd session',
    };
    await first.save(state, [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'remember me' } },
    ]);

    // Server 2 starts in projectA (different startup dir) and receives session/load for projectB.
    const second = createAcpSessionPersistence(projectAStoreDir, resolveDir);
    const loaded = await second.load('sess_cross_1', projectBCwd);
    expect(loaded).toMatchObject({
      id: 'sess_cross_1',
      cwd: projectBCwd,
      title: 'Cross-cwd session',
    });
    expect(loaded?.history).toHaveLength(1);

    // session/list with cwd=projectB finds it too.
    const listed = await second.list?.(projectBCwd);
    expect(listed?.map((e) => e.id)).toContain('sess_cross_1');

    // session/delete removes it from projectB's store.
    await second.delete?.('sess_cross_1', projectBCwd);
    expect(await second.load('sess_cross_1', projectBCwd)).toBeNull();
  });

  it('falls back to the startup project store for sessions saved before cwd-aware routing', async () => {
    const root = await mkTempRoot();
    const startupStoreDir = path.join(root, 'stores', 'startup');
    const otherStoreDir = path.join(root, 'stores', 'other');
    const otherCwd = path.join(root, 'work', 'other');
    await fsp.mkdir(otherCwd, { recursive: true });

    // Save directly to startupStoreDir (simulating an older server build).
    const legacy = createAcpSessionPersistence(startupStoreDir, () => startupStoreDir);
    await legacy.save({
      id: 'sess_legacy_1',
      cwd: otherCwd,
      abort: new AbortController(),
      modeId: 'code',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:01:00.000Z',
    });

    // New server resolves otherCwd → otherStoreDir, misses there, falls back to startupStoreDir.
    const next = createAcpSessionPersistence(startupStoreDir, () => otherStoreDir);
    const loaded = await next.load('sess_legacy_1', otherCwd);
    expect(loaded?.id).toBe('sess_legacy_1');
  });
});
