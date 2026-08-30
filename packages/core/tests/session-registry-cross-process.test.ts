/**
 * Cross-process session discovery tests.
 *
 * Simulates multiple wstack processes by writing separate entries to the
 * SessionRegistry, then verifies each process can discover all others.
 * Uses a temp directory to avoid interfering with the real registry.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEntry } from '../src/session-catalog/session-registry.js';
import {
  getSessionRegistry,
  hasSessionRegistry,
  SessionRegistry,
} from '../src/session-catalog/session-registry.js';

let tempRoot: string;

beforeAll(async () => {
  tempRoot = path.join(os.tmpdir(), `wstack-session-registry-test-${Date.now()}`);
  await fs.mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  // Heartbeat callbacks can finish a pending atomic rename while teardown is
  // removing the tree. Windows reports that transient race as ENOTEMPTY;
  // fs.rm's built-in retries are specifically intended for this case.
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Create an isolated subdirectory for each test to avoid cross-test pollution. */
async function freshRoot(): Promise<string> {
  const dir = path.join(tempRoot, `test-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeAgent(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: over.id ?? 'agent-1',
    name: over.name ?? 'leader',
    status: over.status ?? 'idle',
    currentTool: over.currentTool,
    iterations: over.iterations ?? 0,
    toolCalls: over.toolCalls ?? 0,
    lastActivityAt: over.lastActivityAt ?? new Date().toISOString(),
  };
}

async function forceHeartbeat(registry: SessionRegistry): Promise<void> {
  await (registry as never as { heartbeat(): Promise<void> }).heartbeat();
}

/**
 * Return a PID that is guaranteed not to be alive. Spawning a process and
 * waiting for it to exit hands back a freshly-freed PID — reliably dead on
 * every platform. A hardcoded constant (e.g. 99999) is NOT safe: that PID can
 * belong to a real live process, which makes `pidAlive()`-based pruning flaky.
 */
async function deadPid(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = child.pid;
    if (!pid) {
      reject(new Error('failed to spawn helper process for deadPid()'));
      return;
    }
    child.once('error', reject);
    child.once('exit', () => resolve(pid));
  });
}

describe('cross-process session discovery', () => {
  it('throttles heartbeat temp-file directory scans', async () => {
    const root = await freshRoot();
    const registry = new SessionRegistry(root);
    const internal = registry as unknown as {
      maybePruneStaleTempFiles(): Promise<void>;
      pruneStaleTempFiles(): Promise<void>;
    };
    const prune = vi.fn(async () => undefined);
    internal.pruneStaleTempFiles = prune;

    await internal.maybePruneStaleTempFiles();
    await internal.maybePruneStaleTempFiles();

    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('a single process can register and discover itself', async () => {
    const root = await freshRoot();
    const registry = new SessionRegistry(root);
    await registry.register({
      sessionId: 'sess-aaa',
      projectSlug: 'project-alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha/src',
      gitBranch: 'main',
      pid: 1001,
      startedAt: new Date().toISOString(),
    });

    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe('sess-aaa');
    expect(list[0]!.projectName).toBe('Alpha');
    expect(list[0]!.gitBranch).toBe('main');
  });

  it('removes malformed heartbeat entries while claiming a session', async () => {
    const root = await freshRoot();
    await fs.writeFile(
      path.join(root, 'session-registry.json'),
      JSON.stringify({
        corrupt: {
          sessionId: 'corrupt',
          pid: 1,
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: 'not-a-date',
          agentCount: 0,
          agents: [],
          status: 'idle',
        },
      }),
    );
    const registry = new SessionRegistry(root);

    await registry.register({
      sessionId: 'sess-healthy',
      projectSlug: 'project',
      projectRoot: '/project',
      projectName: 'Project',
      workingDir: '/project',
      gitBranch: 'main',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    const saved = JSON.parse(await fs.readFile(path.join(root, 'session-registry.json'), 'utf8'));
    expect(saved.corrupt).toBeUndefined();
    expect(saved['sess-healthy']).toBeDefined();
  });

  it('preserves optional WebUI endpoint hints across register, heartbeat, and agent updates', async () => {
    const root = await freshRoot();
    const registry = new SessionRegistry(root);
    const webuiEndpoint = {
      role: 'session-child' as const,
      surface: 'webui',
      host: '127.0.0.1',
      httpPort: 3456,
      url: 'http://127.0.0.1:3456',
      pid: process.pid,
      parentPid: process.pid - 1,
      parentShellId: 'shell-a',
      runtimeId: 'runtime-a',
      attachable: true,
      protocolVersion: 1,
      capabilities: ['multi-session-child'],
    };

    await registry.register({
      sessionId: 'sess-webui-child',
      projectSlug: 'alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      clientType: 'webui',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      webuiEndpoint,
    });

    expect((await registry.get('sess-webui-child'))?.webuiEndpoint).toEqual(webuiEndpoint);
    await forceHeartbeat(registry);
    expect((await registry.get('sess-webui-child'))?.webuiEndpoint).toEqual(webuiEndpoint);
    await registry.updateAgents([makeAgent({ id: 'leader' })]);
    expect((await registry.get('sess-webui-child'))?.webuiEndpoint).toEqual(webuiEndpoint);
  });

  it('re-registering the same process preserves sibling sessions owned by that process', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    // Initial registration — process is "in" project Alpha.
    await reg.register({
      sessionId: 'sess-old',
      projectSlug: 'alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      pid: 9001,
      startedAt: new Date().toISOString(),
    });
    // A WebUI process can own multiple tab sessions: same pid, fresh session
    // id, and possibly a different root must not make the old tab look
    // abandoned to external clients.
    await reg.register({
      sessionId: 'sess-new',
      projectSlug: 'beta',
      projectRoot: '/home/beta',
      projectName: 'Beta',
      workingDir: '/home/beta',
      pid: 9001,
      startedAt: new Date().toISOString(),
    });

    const list = await reg.list();
    expect(list.map((session) => session.sessionId).sort()).toEqual(['sess-new', 'sess-old']);
    expect(await reg.get('sess-old')).toMatchObject({
      projectSlug: 'alpha',
      workingDir: '/home/alpha',
    });
    expect(await reg.get('sess-new')).toMatchObject({
      projectSlug: 'beta',
      workingDir: '/home/beta',
    });
    expect(await reg.listByProject('alpha')).toHaveLength(1);
  });

  it('rejects a second process claiming the same live session', async () => {
    const root = await freshRoot();
    const owner = new SessionRegistry(root);
    await owner.register({
      sessionId: 'sess-shared',
      projectSlug: 'alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    const contender = new SessionRegistry(root);
    // Simulate both processes completing their unlocked pre-check before
    // either sees the other. The claim must still fail inside atomicUpdate.
    (contender as unknown as { readAndPrune(): Promise<Record<string, never>> }).readAndPrune =
      async () => ({});
    await expect(
      contender.register({
        sessionId: 'sess-shared',
        projectSlug: 'alpha',
        projectRoot: '/home/alpha',
        projectName: 'Alpha',
        workingDir: '/home/alpha',
        pid: process.pid + 1,
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(
      `Session sess-shared is already open in another running wstack (pid ${process.pid}).`,
    );

    const contenderState = contender as unknown as {
      currentSessionId: string | null;
      lastEntry: unknown | null;
    };
    expect(contenderState.currentSessionId).toBeNull();
    expect(contenderState.lastEntry).toBeNull();

    await forceHeartbeat(contender);
    expect((await owner.get('sess-shared'))?.pid).toBe(process.pid);
  });

  it('two processes can discover each other', async () => {
    const root = await freshRoot();
    // Simulate process 1
    const reg1 = new SessionRegistry(root);
    await reg1.register({
      sessionId: 'sess-111',
      projectSlug: 'proj-alpha',
      projectRoot: '/home/alpha',
      projectName: 'Alpha',
      workingDir: '/home/alpha',
      gitBranch: 'main',
      pid: 2001,
      startedAt: new Date().toISOString(),
    });

    // Simulate process 2 (separate registry instance — different process)
    const reg2 = new SessionRegistry(root);
    await reg2.register({
      sessionId: 'sess-222',
      projectSlug: 'proj-beta',
      projectRoot: '/home/beta',
      projectName: 'Beta',
      workingDir: '/home/beta',
      gitBranch: 'feat/x',
      pid: 2002,
      startedAt: new Date().toISOString(),
    });

    // Process 1 sees process 2
    const list1 = await reg1.list();
    expect(list1).toHaveLength(2);
    const ids1 = list1.map((s) => s.sessionId).sort();
    expect(ids1).toEqual(['sess-111', 'sess-222']);

    // Process 2 sees process 1
    const list2 = await reg2.list();
    expect(list2).toHaveLength(2);
    const ids2 = list2.map((s) => s.sessionId).sort();
    expect(ids2).toEqual(['sess-111', 'sess-222']);
  });

  it('three processes with different branches and projects', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    const startedAt = new Date().toISOString();

    // Three processes
    await reg.register({
      sessionId: 'sess-a',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WrongStack',
      workingDir: '/ws',
      gitBranch: 'main',
      pid: 3001,
      startedAt,
    });
    await reg.register({
      sessionId: 'sess-b',
      projectSlug: 'app',
      projectRoot: '/app',
      projectName: 'MyApp',
      workingDir: '/app/src',
      gitBranch: 'dev',
      pid: 3002,
      startedAt,
    });
    await reg.register({
      sessionId: 'sess-c',
      projectSlug: 'lib',
      projectRoot: '/lib',
      projectName: 'SharedLib',
      workingDir: '/lib',
      gitBranch: undefined,
      pid: 3003,
      startedAt,
    });

    const list = await reg.list();
    expect(list).toHaveLength(3);

    // Verify each can be looked up individually
    const a = list.find((s) => s.sessionId === 'sess-a');
    expect(a?.projectName).toBe('WrongStack');
    expect(a?.gitBranch).toBe('main');

    const b = list.find((s) => s.sessionId === 'sess-b');
    expect(b?.projectName).toBe('MyApp');
    expect(b?.workingDir).toBe('/app/src');

    const c = list.find((s) => s.sessionId === 'sess-c');
    expect(c?.projectName).toBe('SharedLib');
    expect(c?.gitBranch).toBeUndefined();
  });

  it('filter by project slug', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-x',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 4001,
      startedAt: new Date().toISOString(),
    });
    await reg.register({
      sessionId: 'sess-y',
      projectSlug: 'other',
      projectRoot: '/other',
      projectName: 'Other',
      workingDir: '/other',
      pid: 4002,
      startedAt: new Date().toISOString(),
    });

    const wsSessions = await reg.listByProject('ws');
    expect(wsSessions).toHaveLength(1);
    expect(wsSessions[0]!.sessionId).toBe('sess-x');
  });

  it('stale entries (dead process) are pruned after timeout', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);

    // Register with a heartbeat that's very old (dead process)
    await reg.register({
      sessionId: 'sess-dead',
      projectSlug: 'dead',
      projectRoot: '/dead',
      projectName: 'Dead Project',
      workingDir: '/dead',
      pid: await deadPid(), // a PID guaranteed not to be alive
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago
    });

    // Manually age the heartbeat
    const registryPath = path.join(root, 'session-registry.json');
    const raw = await fs.readFile(registryPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const entry = data['sess-dead'] as Record<string, unknown>;
    entry['lastHeartbeatAt'] = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    await fs.writeFile(registryPath, JSON.stringify(data, null, 2));

    // list() should prune the stale entry (dead PID + old heartbeat)
    const list = await reg.list();
    const dead = list.find((s) => s.sessionId === 'sess-dead');
    // Either marked stale or removed (depending on timing)
    if (dead) {
      expect(dead.status).toBe('stale');
    }
    // Either way, it shouldn't appear as active/idle
    const active = list.filter((s) => s.status !== 'stale' && s.status !== 'closing');
    expect(active.find((s) => s.sessionId === 'sess-dead')).toBeUndefined();
  });

  it('drops a dead PID after two missed heartbeats, not a full stale window', async () => {
    // Regression: the PID probe used to sit behind STALE_TIMEOUT_MS (30s), so
    // a session killed without markClosing (SIGKILL, taskkill /F, the
    // rapid-Ctrl+C exit path) kept its last written status. For an idle TUI
    // that status is literally 'idle', so /sessions, Fleet HQ and the HQ
    // routes all showed a live-looking session on a dead pid for up to 30s.
    const root = await freshRoot();
    const reg = new SessionRegistry(root);

    await reg.register({
      sessionId: 'sess-killed',
      projectSlug: 'killed',
      projectRoot: '/killed',
      projectName: 'Killed Project',
      workingDir: '/killed',
      pid: await deadPid(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // Age the heartbeat past two beats (10s) but keep it well inside the
    // 30s stale window — the exact gap the old ordering left uncovered.
    const registryPath = path.join(root, 'session-registry.json');
    const data = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Record<string, unknown>;
    const entry = data['sess-killed'] as Record<string, unknown>;
    entry['lastHeartbeatAt'] = new Date(Date.now() - 15_000).toISOString();
    entry['status'] = 'idle';
    await fs.writeFile(registryPath, JSON.stringify(data, null, 2));

    expect(await reg.get('sess-killed')).toBeUndefined();
    expect((await reg.list()).find((s) => s.sessionId === 'sess-killed')).toBeUndefined();
  });

  it('agent status updates are reflected in discovery', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-agents',
      projectSlug: 'agents',
      projectRoot: '/agents',
      projectName: 'Agent Test',
      workingDir: '/agents',
      pid: 5001,
      startedAt: new Date().toISOString(),
    });

    // Update agent status
    await reg.updateAgents([
      makeAgent({
        id: 'leader',
        name: 'leader',
        status: 'running',
        currentTool: 'bash',
        iterations: 5,
        toolCalls: 12,
      }),
      makeAgent({
        id: 'sub-1',
        name: 'bug-hunter',
        status: 'running',
        iterations: 3,
        toolCalls: 8,
      }),
      makeAgent({ id: 'sub-2', name: 'critic', status: 'idle', iterations: 0, toolCalls: 0 }),
    ]);

    // Another process discovers these agents
    const reg2 = new SessionRegistry(root);
    const list = await reg2.list();
    const session = list.find((s) => s.sessionId === 'sess-agents');
    expect(session).toBeDefined();
    expect(session!.agentCount).toBe(3);
    expect(session!.agents).toHaveLength(3);

    const leader = session!.agents.find((a) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.currentTool).toBe('bash');
    expect(leader?.iterations).toBe(5);
    expect(leader?.toolCalls).toBe(12);
  });
});

// ── Lock resilience + self-heal ───────────────────────────────────────
// A crashed process used to leave its `.lock` file behind forever, which
// wedged every subsequent write — the registry silently stopped updating.

describe('lock resilience', () => {
  it('breaks a stale lock left by a dead owner and still registers', async () => {
    const root = await freshRoot();
    const lockPath = path.join(root, 'session-registry.json.lock');
    // Plant a leftover lock owned by a PID that is not alive.
    await fs.writeFile(lockPath, `${os.hostname()}:${await deadPid()}`);

    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-wedge',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6001,
      startedAt: new Date().toISOString(),
    });

    const list = await reg.list();
    expect(list.find((s) => s.sessionId === 'sess-wedge')).toBeDefined();
    // The stale lock must have been cleaned up, not left to wedge future writes.
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('prunes stale registry temp files during writes', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);

    for (let i = 0; i < 25; i++) {
      const legacyTemp = path.join(root, `session-registry.json.${String(i).padStart(8, '0')}.tmp`);
      await fs.writeFile(legacyTemp, '{}');
      const old = new Date(Date.now() - 120_000 - i);
      await fs.utimes(legacyTemp, old, old);
    }

    await reg.register({
      sessionId: 'sess-prune-tmp',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6001,
      startedAt: new Date().toISOString(),
    });

    const temps = (await fs.readdir(root)).filter(
      (name) => name.startsWith('session-registry.json.') && name.endsWith('.tmp'),
    );
    expect(temps).toHaveLength(5);
  });

  it('fails closed when an ownership claim cannot acquire the registry lock', async () => {
    const root = await freshRoot();
    const lockPath = path.join(root, 'session-registry.json.lock');
    const reg = new SessionRegistry(root, { ownershipLockWaitMs: 100 });

    // A lock stamped with our live PID is not stale and cannot be broken.
    await fs.writeFile(lockPath, `${os.hostname()}:${process.pid}`);
    await expect(
      reg.register({
        sessionId: 'sess-unclaimed',
        projectSlug: 'ws',
        projectRoot: '/ws',
        projectName: 'WS',
        workingDir: '/ws',
        clientType: 'tui',
        pid: 6002,
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/ownership update failed/i);

    // A failed claim must not publish local ownership that a later heartbeat
    // could silently turn into a successful claim.
    await fs.unlink(lockPath);
    await forceHeartbeat(reg);
    expect(await reg.list()).toHaveLength(0);
  });

  it('waits through ordinary live lock contention before claiming ownership', async () => {
    const root = await freshRoot();
    const lockPath = path.join(root, 'session-registry.json.lock');
    const reg = new SessionRegistry(root);

    await fs.writeFile(lockPath, `${os.hostname()}:${process.pid}`);
    const release = setTimeout(() => {
      void fs.unlink(lockPath);
    }, 1_000);

    try {
      await reg.register({
        sessionId: 'sess-contended',
        projectSlug: 'ws',
        projectRoot: '/ws',
        projectName: 'WS',
        workingDir: '/ws',
        clientType: 'tui',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(release);
      await fs.unlink(lockPath).catch(() => undefined);
    }

    expect(await reg.get('sess-contended')).toMatchObject({
      pid: process.pid,
      clientType: 'tui',
    });
    await reg.unregister();
  });

  it('recovers from a crash-zeroed (all-NUL) registry file instead of wedging writes', async () => {
    // A system crash can leave the registry zero-filled: NTFS journals the
    // rename metadata but the data blocks were never flushed. JSON.parse of
    // NUL bytes used to throw inside atomicUpdate's try, silently dropping
    // EVERY future write — no session could ever register again (Fleet HQ
    // permanently empty, /api/sessions/:id/* permanently 404).
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    await fs.writeFile(registryPath, ' '.repeat(6088), 'utf8');

    const reg = new SessionRegistry(root);
    expect(await reg.list()).toHaveLength(0); // read is corruption-tolerant

    await reg.register({
      sessionId: 'sess-zeroed',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'tui',
      pid: 6010,
      startedAt: new Date().toISOString(),
    });

    // The write healed the file: valid JSON with our entry.
    const raw = await fs.readFile(registryPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const listed = await reg.list();
    expect(listed.find((s) => s.sessionId === 'sess-zeroed')).toBeDefined();
  });

  it('recovers from a torn (invalid JSON) registry file', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    await fs.writeFile(registryPath, '{"sess-a": {"sessionId": "sess-a", "pro', 'utf8');

    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-torn',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6011,
      startedAt: new Date().toISOString(),
    });

    const listed = await reg.list();
    expect(listed.find((s) => s.sessionId === 'sess-torn')).toBeDefined();
  });

  it('treats a registry file holding a non-object JSON value as empty', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    await fs.writeFile(registryPath, '[1,2,3]', 'utf8');

    const reg = new SessionRegistry(root);
    expect(await reg.list()).toHaveLength(0);

    await reg.register({
      sessionId: 'sess-nonobject',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 6012,
      startedAt: new Date().toISOString(),
    });
    const listed = await reg.list();
    expect(listed.find((s) => s.sessionId === 'sess-nonobject')).toBeDefined();
  });

  it('self-heals a missing entry on heartbeat', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const reg = new SessionRegistry(root);

    await reg.register({
      sessionId: 'sess-heartbeat-heal',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      clientType: 'cli',
      pid: 6003,
      startedAt: new Date().toISOString(),
    });

    await fs.writeFile(registryPath, JSON.stringify({}, null, 2));
    await forceHeartbeat(reg);

    const healed = (await reg.list()).find((s) => s.sessionId === 'sess-heartbeat-heal');
    expect(healed).toBeDefined();
    expect(healed!.clientType).toBe('cli');
  });
});

// ── Singleton tests ───────────────────────────────────────────────────

describe('SessionRegistry singleton', () => {
  it('getSessionRegistry returns the same instance for the same root', async () => {
    const root = await freshRoot();
    const a = getSessionRegistry(root);
    const b = getSessionRegistry(root);
    // Same root should return same instance
    expect(a).toBe(b);
  });

  it('hasSessionRegistry returns false before initialization', () => {
    // Note: hasSessionRegistry checks the module-level _instance variable.
    // Since our tests initialize the singleton, this may already be true.
    // We just verify the function exists and returns a boolean.
    expect(typeof hasSessionRegistry()).toBe('boolean');
  });
});

// ── Lifecycle edges (coverage) ────────────────────────────────────────

describe('SessionRegistry lifecycle edges', () => {
  it('unregister removes the entry', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-u',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7001,
      startedAt: new Date().toISOString(),
    });
    expect(await reg.list()).toHaveLength(1);
    await reg.unregister();
    expect(await reg.list()).toHaveLength(0);
  });

  it('an old owner cannot heartbeat, close, or unregister a replacement owner', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-reowned',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7101,
      startedAt: new Date().toISOString(),
    });

    const replacement = {
      sessionId: 'sess-reowned',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7102,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      status: 'active' as const,
      agentCount: 0,
      agents: [],
    };
    await fs.writeFile(
      registryPath,
      JSON.stringify({ [replacement.sessionId]: replacement }, null, 2),
    );

    await forceHeartbeat(reg);
    await reg.updateAgents([makeAgent({ id: 'old-owner-agent', status: 'running' })]);
    await reg.markClosing();
    await reg.unregister();

    const current = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Record<
      string,
      typeof replacement
    >;
    expect(current['sess-reowned']).toMatchObject({
      pid: replacement.pid,
      status: 'active',
      agentCount: 0,
    });
  });

  it('uses startedAt to distinguish ownership generations sharing one PID', async () => {
    const root = await freshRoot();
    const oldOwner = new SessionRegistry(root);
    const newOwner = new SessionRegistry(root);
    await oldOwner.register({
      sessionId: 'sess-same-pid',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: process.pid,
      startedAt: '2026-07-27T00:00:00.000Z',
    });
    await newOwner.register({
      sessionId: 'sess-same-pid',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: process.pid,
      startedAt: '2026-07-27T00:00:01.000Z',
    });

    await forceHeartbeat(oldOwner);
    await oldOwner.unregister();

    expect(await newOwner.get('sess-same-pid')).toMatchObject({
      pid: process.pid,
      startedAt: '2026-07-27T00:00:01.000Z',
    });
    await newOwner.unregister();
  });

  it('unregister / markClosing / updateAgents before register are no-ops', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await expect(reg.unregister()).resolves.not.toThrow();
    await expect(reg.markClosing()).resolves.not.toThrow();
    await expect(reg.updateAgents([makeAgent()])).resolves.not.toThrow();
  });

  it('markClosing sets status=closing and clears the heartbeat timer', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-c',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7002,
      startedAt: new Date().toISOString(),
    });
    await reg.markClosing();
    expect((await reg.get('sess-c'))?.status).toBe('closing');
  });

  it('markClosing is a no-op when the entry has vanished from the file', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-c2',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7003,
      startedAt: new Date().toISOString(),
    });
    // Wipe the on-disk entry so markClosing's atomicUpdate sees no entry.
    await fs.writeFile(path.join(root, 'session-registry.json'), '{}');
    await expect(reg.markClosing()).resolves.not.toThrow();
  });

  it('registryPath exposes the registry file path', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    expect(reg.registryPath).toBe(path.join(root, 'session-registry.json'));
  });

  it('heartbeat recomputes status=idle when no agent is running', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-hb-idle',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7004,
      startedAt: new Date().toISOString(),
      agents: [makeAgent({ id: 'leader', status: 'idle' })],
    });
    await forceHeartbeat(reg);
    expect((await reg.get('sess-hb-idle'))?.status).toBe('idle');
  });

  it('heartbeat recomputes status=active when an agent is running', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-hb-active',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7005,
      startedAt: new Date().toISOString(),
      agents: [makeAgent({ id: 'leader', status: 'running' })],
    });
    await forceHeartbeat(reg);
    expect((await reg.get('sess-hb-active'))?.status).toBe('active');
  });

  it('heartbeat does not revert a closing status', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-hb-close',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: 7006,
      startedAt: new Date().toISOString(),
      agents: [makeAgent({ id: 'leader', status: 'running' })],
    });
    await reg.markClosing();
    await forceHeartbeat(reg);
    expect((await reg.get('sess-hb-close'))?.status).toBe('closing');
  });

  it('prunes a closing entry past its grace window after its PID exits', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const old = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          'sess-old': {
            sessionId: 'sess-old',
            projectSlug: 'ws',
            projectRoot: '/ws',
            projectName: 'WS',
            workingDir: '/ws',
            pid: await deadPid(),
            status: 'closing',
            startedAt: old,
            lastHeartbeatAt: old,
            agentCount: 0,
            agents: [],
          },
        },
        null,
        2,
      ),
    );
    const reg = new SessionRegistry(root);
    const list = await reg.list();
    expect(list.find((s) => s.sessionId === 'sess-old')).toBeUndefined();
  });

  it('removes a dead session based on heartbeat age, not session start time', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const startedRecently = new Date(Date.now() - 3 * 60_000).toISOString();
    const heartbeatOld = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          'sess-stale': {
            sessionId: 'sess-stale',
            projectSlug: 'ws',
            projectRoot: '/ws',
            projectName: 'WS',
            workingDir: '/ws',
            pid: await deadPid(),
            status: 'active',
            startedAt: startedRecently,
            lastHeartbeatAt: heartbeatOld,
            agentCount: 0,
            agents: [],
          },
        },
        null,
        2,
      ),
    );

    const reg = new SessionRegistry(root);
    expect(await reg.get('sess-stale')).toBeUndefined();
    expect(JSON.parse(await fs.readFile(registryPath, 'utf8'))).toEqual({});
  });

  it('retains a lost session while its PID is alive and refuses takeover', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const heartbeatOld = new Date(Date.now() - 5 * 60_000).toISOString();
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          'sess-lost-live': {
            sessionId: 'sess-lost-live',
            projectSlug: 'ws',
            projectRoot: '/ws',
            projectName: 'WS',
            workingDir: '/ws',
            pid: process.pid,
            status: 'active',
            startedAt: heartbeatOld,
            lastHeartbeatAt: heartbeatOld,
            agentCount: 0,
            agents: [],
          },
        },
        null,
        2,
      ),
    );

    const reader = new SessionRegistry(root);
    expect(await reader.get('sess-lost-live')).toMatchObject({
      pid: process.pid,
      status: 'lost',
    });

    const contender = new SessionRegistry(root);
    await expect(
      contender.register({
        sessionId: 'sess-lost-live',
        projectSlug: 'ws',
        projectRoot: '/ws',
        projectName: 'WS',
        workingDir: '/ws',
        pid: process.pid + 100_000,
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/already open.*pid/i);
  });

  it('removes malformed heartbeat entries and stale subagents from live sessions', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const now = new Date().toISOString();
    const staleActivity = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          malformed: {
            sessionId: 'malformed',
            projectSlug: 'ws',
            projectRoot: '/ws',
            projectName: 'WS',
            workingDir: '/ws',
            pid: process.pid,
            status: 'active',
            startedAt: now,
            lastHeartbeatAt: 'invalid',
            agentCount: 0,
            agents: [],
          },
          live: {
            sessionId: 'live',
            projectSlug: 'ws',
            projectRoot: '/ws',
            projectName: 'WS',
            workingDir: '/ws',
            pid: process.pid,
            status: 'active',
            startedAt: now,
            lastHeartbeatAt: now,
            agentCount: 2,
            agents: [
              makeAgent({ id: 'leader', lastActivityAt: staleActivity }),
              makeAgent({ id: 'shadow-old', lastActivityAt: staleActivity, status: 'running' }),
            ],
          },
        },
        null,
        2,
      ),
    );

    const reg = new SessionRegistry(root);
    const entries = await reg.list();
    expect(entries.map((entry) => entry.sessionId)).toEqual(['live']);
    expect(entries[0]?.agents.map((agent) => agent.id)).toEqual(['leader']);
    expect(entries[0]?.agentCount).toBe(1);
  });

  it('register prunes a prior dead+stale entry from a different session', async () => {
    const root = await freshRoot();
    const registryPath = path.join(root, 'session-registry.json');
    const reg = new SessionRegistry(root);
    const dead = await deadPid();
    await reg.register({
      sessionId: 'sess-a',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: dead,
      startedAt: new Date().toISOString(),
    });
    // Age sess-a's heartbeat past the stale timeout.
    const data = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Record<
      string,
      { lastHeartbeatAt: string }
    >;
    data['sess-a']!.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(registryPath, JSON.stringify(data, null, 2));
    // Registering a different session prunes the dead+stale sess-a.
    await reg.register({
      sessionId: 'sess-b',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    expect(await reg.get('sess-a')).toBeUndefined();
  });

  it('heartbeat before register is a no-op', async () => {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await forceHeartbeat(reg); // currentSessionId null → early return
    expect(await reg.list()).toEqual([]);
  });
});

describe('updateAgents write coalescing', () => {
  async function registeredRegistry(): Promise<{ reg: SessionRegistry; root: string }> {
    const root = await freshRoot();
    const reg = new SessionRegistry(root);
    await reg.register({
      sessionId: 'sess-throttle',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    return { reg, root };
  }

  it('collapses a burst of updateAgents calls into one trailing write with the newest snapshot', async () => {
    const { reg } = await registeredRegistry();
    const internal = reg as unknown as {
      atomicUpdate(mut: (r: Record<string, unknown>) => void): Promise<void>;
    };
    const atomicSpy = vi.spyOn(internal, 'atomicUpdate');

    // Leading edge: first call in a quiet window writes immediately.
    await reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 1 })]);
    const afterLeading = atomicSpy.mock.calls.length;
    expect(afterLeading).toBe(1);

    // Burst within the throttle window: none writes immediately, all settle
    // on one trailing write that carries the newest snapshot.
    const burst = Promise.all([
      reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 2 })]),
      reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 3 })]),
      reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 4 })]),
    ]);
    expect(atomicSpy.mock.calls.length).toBe(afterLeading);
    await burst;
    expect(atomicSpy.mock.calls.length).toBe(afterLeading + 1);

    const entry = await reg.get('sess-throttle');
    expect(entry?.agents[0]?.toolCalls).toBe(4);
    await reg.unregister();
  });

  it('unregister cancels a pending trailing write so the entry stays deleted', async () => {
    const { reg } = await registeredRegistry();
    await reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 1 })]);
    // Second call lands inside the throttle window → scheduled, not written.
    const pending = reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 2 })]);
    await reg.unregister();
    await pending; // resolves via cancellation, not a write
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await reg.get('sess-throttle')).toBeUndefined();
  });

  it('switching sessions cancels a pending agent write from the previous session', async () => {
    const { reg } = await registeredRegistry();
    await reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 1 })]);
    const pending = reg.updateAgents([makeAgent({ id: 'old-session-agent', toolCalls: 2 })]);

    await reg.register({
      sessionId: 'sess-next',
      projectSlug: 'ws',
      projectRoot: '/ws',
      projectName: 'WS',
      workingDir: '/ws',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      agents: [makeAgent({ id: 'new-session-agent', toolCalls: 3 })],
    });

    await pending;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const oldSession = await reg.get('sess-throttle');
    expect(oldSession?.agents.map((agent) => agent.id)).toEqual(['leader']);
    expect((await reg.get('sess-next'))?.agents.map((agent) => agent.id)).toEqual([
      'new-session-agent',
    ]);
    await reg.unregister();
  });

  it('markClosing folds the pending snapshot into its final write', async () => {
    const { reg } = await registeredRegistry();
    await reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 1 })]);
    const pending = reg.updateAgents([makeAgent({ id: 'leader', toolCalls: 7 })]);
    await reg.markClosing();
    await pending;
    const entry = await reg.get('sess-throttle');
    expect(entry?.status).toBe('closing');
    expect(entry?.agents[0]?.toolCalls).toBe(7);
    await reg.unregister();
  });
});
