import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetWrongTraceGate } from '../gate.js';
import {
  createWrongTraceHookPair,
  createWrongTracePostToolUseHook,
  createWrongTracePreToolUseHook,
} from '../hooks.js';

/**
 * Hermetic hook-pair contract tests. Overrides globalThis.fetch with a stub
 * daemon and drives preToolUse/postToolUse end to end; asserts the typed
 * gate-decision events (deny / allow-fragile / lock-acquired /
 * lock-conflict-race / lock-released) emitted by the pair.
 *
 * Regression focus: lock-released is emitted ONLY on a confirmed daemon
 * unlock (released !== null && released.ok !== false), mirroring
 * lock-acquired's confirmed-emission rule — a failed unlock must not record
 * a release the daemon never performed.
 */

function makeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return responder(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function healthyHealth(): Response {
  return jsonResponse({ status: 'ok', socket_path: '' }); // IPC unwired
}

function healthyFileHealth(): Response {
  return jsonResponse({
    path: '',
    health_score: 100,
    is_fragile: false,
    recent_thrashing_count: 0,
    is_locked: false,
  });
}

describe('createWrongTraceHookPair gate events', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWrongTraceGate();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it('emits lock-acquired and lock-released on a confirmed acquire+release cycle', async () => {
    let unlockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock')
        return jsonResponse({ ok: true, path: '', status: 'locked' });
      if (u.pathname === '/api/guardrail/unlock') {
        unlockCalls++;
        return jsonResponse({ ok: true, path: 'src/foo.ts', status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => 'sess-test', { emit: (e) => events.push(e.kind) });

    const pre = await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    expect(pre).toEqual({ action: 'allow' });
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });

    expect(unlockCalls).toBe(1);
    expect(events).toContain('lock-acquired');
    expect(events).toContain('lock-released');
  });

  it('does NOT emit lock-released when the daemon unlock fails (HTTP 503 → null)', async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock')
        return jsonResponse({ ok: true, path: '', status: 'locked' });
      if (u.pathname === '/api/guardrail/unlock') return new Response('boom', { status: 503 });
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => 'sess-test', { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });

    expect(events).toContain('lock-acquired');
    expect(events).not.toContain('lock-released');
  });

  it('does NOT emit lock-released when the daemon returns ok:false on unlock (409 conflict body)', async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock')
        return jsonResponse({ ok: true, path: '', status: 'locked' });
      if (u.pathname === '/api/guardrail/unlock') {
        return jsonResponse({ ok: false, status: 'conflict', error: 'not ours' }, 409);
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => 'sess-test', { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });

    expect(events).toContain('lock-acquired');
    expect(events).not.toContain('lock-released');
  });

  it('does NOT emit lock-released when the daemon is offline at postToolUse', async () => {
    let offline = false;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock')
        return jsonResponse({ ok: true, path: '', status: 'locked' });
      if (u.pathname === '/api/guardrail/unlock') {
        offline = true;
        throw new Error('ECONNREFUSED');
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => 'sess-test', { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });

    expect(offline).toBe(true);
    expect(events).toContain('lock-acquired');
    expect(events).not.toContain('lock-released');
  });

  it('skips the daemon entirely while a sibling still holds the path (refcount 2→1)', async () => {
    let unlockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock')
        return jsonResponse({ ok: true, path: '', status: 'locked' });
      if (u.pathname === '/api/guardrail/unlock') {
        unlockCalls++;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    // Pre-seeded refcount 2: one sibling is still editing — this release
    // must only decrement, never hit the daemon, never emit.
    const counters = new Map<string, number>([[resolve('src/foo.ts'), 2]]);
    const events: string[] = [];
    const pair = createWrongTraceHookPair(
      () => 'sess-test',
      { emit: (e) => events.push(e.kind) },
      counters,
    );

    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });

    expect(unlockCalls).toBe(0);
    expect(events).not.toContain('lock-released');
    expect(counters.get(resolve('src/foo.ts'))).toBe(1);
  });

  it("does NOT let a lock-conflict-race release a sibling's active claim (refcount participant)", async () => {
    // Regression pin: a racer whose preToolUse failed to acquire counts as
    // an in-flight PARTICIPANT — its own postToolUse decrements its own
    // entry, so a sibling finishing early can never release the daemon lock
    // another executor's edit still holds. The owner-guard then verifies
    // the lock belongs to this session before the LAST finisher unlocks.
    let lockCalls = 0;
    let unlockCalls = 0;
    const OWNER = 'wrongstack:sess-test';
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        return jsonResponse({
          path: 'src/foo.ts',
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: true,
          lock_owner: OWNER,
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        lockCalls++;
        if (lockCalls === 1)
          return jsonResponse({ ok: true, path: 'src/foo.ts', status: 'locked', owner: OWNER });
        return jsonResponse(
          { ok: false, status: 'conflict', error: 'already locked', owner: OWNER },
          409,
        );
      }
      if (u.pathname === '/api/guardrail/unlock') {
        unlockCalls++;
        return jsonResponse({ ok: true, path: 'src/foo.ts', status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => 'sess-test', { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } }); // A acquires
    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } }); // B races
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } }); // B finishes first

    expect(lockCalls).toBe(2); // A acquired, B raced
    expect(unlockCalls).toBe(0); // B must NOT release A's claim
    expect(events).toContain('lock-acquired');
    expect(events).toContain('lock-conflict-race');
    expect(events).not.toContain('lock-released');

    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } }); // A finishes last

    expect(unlockCalls).toBe(1); // the LAST finisher releases exactly once
    expect(events).toContain('lock-released');
  });

  it('cleans up recorded owner and race state so a subsequent session can release its own lock', async () => {
    let currentSession = 'sess-1';
    let currentLockOwner: string | undefined;
    let unlockCalls = 0;

    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        return jsonResponse({
          path: 'src/foo.ts',
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: currentLockOwner !== undefined,
          lock_owner: currentLockOwner,
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        if (currentLockOwner && currentLockOwner !== `wrongstack:${currentSession}`) {
          return jsonResponse({ ok: false, status: 'conflict', owner: currentLockOwner }, 409);
        }
        currentLockOwner = `wrongstack:${currentSession}`;
        return jsonResponse({ ok: true, path: 'src/foo.ts', status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        unlockCalls++;
        currentLockOwner = undefined;
        return jsonResponse({ ok: true, path: 'src/foo.ts', status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const counters = new Map<string, number>();
    const pair = createWrongTraceHookPair(() => currentSession, {}, counters);

    // Session 1 acquires and releases
    currentSession = 'sess-1';
    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    expect(unlockCalls).toBe(1);

    // Session 2 runs. Daemon lock is held by sess-2, but a transient conflict race occurs in preToolUse
    currentSession = 'sess-2';
    currentLockOwner = 'wrongstack:sess-2';

    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/guardrail/lock') {
        return jsonResponse({ ok: false, status: 'conflict', owner: 'wrongstack:sess-2' }, 409);
      }
      return origFetch(url, init);
    });

    await pair.preToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    globalThis.fetch = origFetch;

    // Session 2 finishes. Stale owner from sess-1 must NOT block unlock
    await pair.postToolUse({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    expect(unlockCalls).toBe(2);

    // Legacy single-phase pre/post hooks: when our own session already holds a leaked
    // lock on the daemon (so lockFile returns 409 ok:false), preToolUse records the
    // caller's owner in claimedOwnerSetFor so legacy postToolUse (built with `() => ''`)
    // still recognizes and unlocks our own leaked lock.
    currentSession = 'sess-legacy-self';
    currentLockOwner = 'wrongstack:sess-legacy-self';
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/guardrail/lock') {
        return jsonResponse(
          { ok: false, status: 'conflict', owner: 'wrongstack:sess-legacy-self' },
          409,
        );
      }
      return origFetch2(url, init);
    });
    const preLegacy = createWrongTracePreToolUseHook(() => 'sess-legacy-self');
    const postLegacy = createWrongTracePostToolUseHook();
    await preLegacy({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    globalThis.fetch = origFetch2;
    await postLegacy({ toolName: 'edit', toolInput: { path: 'src/foo.ts' } });
    expect(unlockCalls).toBe(3);
  });

  it('claims for the session in the payload when one pair serves several sessions', async () => {
    const locks = new Map<string, string>();
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        const owner = locks.get(u.searchParams.get('path') ?? '');
        return jsonResponse({
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: owner !== undefined,
          ...(owner ? { lock_owner: owner } : {}),
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        const held = locks.get(body.path);
        if (held && held !== body.owner) return jsonResponse({ ok: false, owner: held }, 409);
        locks.set(body.path, body.owner);
        return jsonResponse({ ok: true, path: body.path, status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        locks.delete(body.path);
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });

    // The WebUI shape: one pair, its closure names the foreground tab only.
    const pair = createWrongTraceHookPair(() => 'tab-1');
    const call = (sessionId: string) => ({
      toolName: 'edit',
      toolInput: { path: 'src/foo.ts' },
      sessionId,
    });
    expect(await pair.preToolUse(call('tab-1'))).toEqual({ action: 'allow' });
    expect((await pair.preToolUse(call('tab-2')))?.action).toBe('deny');
    // The denied call's skipped PostToolUse must leave tab-1's claim alone.
    await pair.postToolUse(call('tab-2'));
    await pair.postToolUse({ toolName: 'edit', toolInput: {}, sessionId: 'tab-1' });
    expect(locks.get(resolve('src/foo.ts'))).toBe('wrongstack:tab-1');
    await pair.postToolUse(call('tab-1'));
    expect(locks.has(resolve('src/foo.ts'))).toBe(false);
  });

  it('withFileLock unlocks only when lockFile succeeded and gate-counters persists and reloads total counts', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { withFileLock } = await import('../gate.js');
    const {
      loadWrongTraceGateCounters,
      persistWrongTraceGateCounters,
      recordGateDecision,
      resetGateDecisions,
      snapshotGateDecisions,
    } = await import('../gate-counters.js');

    const unlocked: string[] = [];
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/guardrail/lock') {
        if (body.path === 'src/locked.ts') {
          return jsonResponse({ ok: true, path: body.path, status: 'locked' });
        }
        return jsonResponse({ ok: false, status: 'conflict' }, 409);
      }
      if (u.pathname === '/api/guardrail/unlock') {
        unlocked.push(body.path);
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });
    resetWrongTraceGate();
    await expect(withFileLock('src/locked.ts', 'test', async () => 'ok')).resolves.toBe('ok');
    await expect(withFileLock('src/conflict.ts', 'test', async () => 'ok2')).resolves.toBe('ok2');
    expect(unlocked).toEqual(['src/locked.ts']);

    const dir = mkdtempSync(join(tmpdir(), 'wt-gate-counters-'));
    try {
      resetGateDecisions();
      recordGateDecision({ kind: 'deny', sessionId: 's1', path: 'src/a.ts', reason: 'locked' });
      recordGateDecision({ kind: 'lock-acquired', sessionId: 's1', path: 'src/b.ts' });
      recordGateDecision({ kind: 'lock-released', sessionId: 's1', path: 'src/b.ts' });
      const snap = snapshotGateDecisions();
      expect(snap.total).toBe(3);
      await persistWrongTraceGateCounters(dir, snap);
      resetGateDecisions();
      const loaded = await loadWrongTraceGateCounters(dir);
      expect(loaded).toEqual({
        deny: 1,
        allowFragile: 0,
        lockAcquired: 1,
        lockConflictRace: 0,
        lockReleased: 1,
        total: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not unlock daemon lock if a new preToolUse re-acquires the path while postToolUse awaits getFileHealth (F143)', async () => {
    let unlockCalls = 0;
    let lockCallCount = 0;
    let healthCallCount = 0;
    let releaseHealthGate: (() => void) | undefined;
    const healthGate = new Promise<void>((r) => {
      releaseHealthGate = r;
    });

    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        healthCallCount++;
        if (healthCallCount === 2) {
          await healthGate;
        }
        return jsonResponse({
          path: 'src/race.ts',
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: true,
          lock_owner: 'wrongstack:sess-1',
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        lockCallCount++;
        if (lockCallCount === 1) {
          return jsonResponse({ ok: false, status: 'conflict' }, 409);
        }
        return jsonResponse({ ok: true, path: 'src/race.ts', status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        unlockCalls++;
        return jsonResponse({ ok: true, path: 'src/race.ts', status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const pair = createWrongTraceHookPair(() => 'sess-1');
    const toolInput = { path: 'src/race.ts' };

    await pair.preToolUse({ toolName: 'edit', toolInput });
    const post1 = pair.postToolUse({ toolName: 'edit', toolInput });
    await new Promise((r) => setTimeout(r, 15));
    await pair.preToolUse({ toolName: 'edit', toolInput });
    releaseHealthGate?.();
    await post1;

    expect(unlockCalls).toBe(0);
    await pair.postToolUse({ toolName: 'edit', toolInput });
    expect(unlockCalls).toBe(1);
  });
});

describe('createWrongTraceHookPair lock keys', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWrongTraceGate();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it('locks a relative path as the file in the session directory, not a shared string', async () => {
    const calls: { op: string; path: unknown }[] = [];
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/guardrail/lock') {
        calls.push({ op: 'lock', path: body.path });
        return jsonResponse({ ok: true, path: body.path, status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        calls.push({ op: 'unlock', path: body.path });
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const a = resolve('projects', 'pricing');
    const b = resolve('projects', 'booking');
    const pairA = createWrongTraceHookPair(() => 'sess-a', { baseDir: () => a });
    const pairB = createWrongTraceHookPair(() => 'sess-b', { baseDir: () => b });
    const write = { toolName: 'write', toolInput: { path: 'index.html' } };

    await pairA.preToolUse(write);
    await pairB.preToolUse(write);
    await pairA.postToolUse(write);
    await pairB.postToolUse(write);

    expect(calls).toEqual([
      { op: 'lock', path: resolve(a, 'index.html') },
      { op: 'lock', path: resolve(b, 'index.html') },
      { op: 'unlock', path: resolve(a, 'index.html') },
      { op: 'unlock', path: resolve(b, 'index.html') },
    ]);
  });
});

describe('createWrongTraceHookPair abandoned pre hook', () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWrongTraceGate();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it('releases a claim that landed after the host stopped waiting for the pre hook', async () => {
    let landLock: (() => void) | undefined;
    const lockLanded = new Promise<void>((resolve) => {
      landLock = resolve;
    });
    let lockRequested: (() => void) | undefined;
    const lockAsked = new Promise<void>((resolve) => {
      lockRequested = resolve;
    });
    const unlocked: unknown[] = [];
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/guardrail/lock') {
        lockRequested?.();
        await lockLanded; // the daemon answers after the host's hook timeout
        return jsonResponse({ ok: true, path: body.path, status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        unlocked.push(body.path);
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const pair = createWrongTraceHookPair(() => 'sess-slow', { baseDir: () => resolve('proj') });
    const write = { toolName: 'write', toolInput: { path: 'index.html' } };
    // The host gave up on this pre hook and ran the tool anyway.
    void pair.preToolUse(write);
    await lockAsked;
    const post = pair.postToolUse(write);
    landLock?.();
    await post;

    expect(unlocked).toEqual([resolve('proj', 'index.html')]);
  });

  it('settles overlapping pending pre-hooks, awaits mid-release pending claims, and normalizes absolute paths (F13)', async () => {
    let activeDaemonOwner: string | undefined;
    let healthCalls = 0;
    let lockCalls = 0;
    let releaseHealthGate!: () => void;
    const healthGate = new Promise<void>((r) => {
      releaseHealthGate = r;
    });
    let pre2EnteredLock!: () => void;
    const pre2InLock = new Promise<void>((r) => {
      pre2EnteredLock = r;
    });
    let releasePre2LockGate!: () => void;
    const pre2LockGate = new Promise<void>((r) => {
      releasePre2LockGate = r;
    });

    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        healthCalls++;
        if (healthCalls === 2) {
          await healthGate;
        }
        return jsonResponse({
          file_path: 'src/race.ts',
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: activeDaemonOwner !== undefined,
          lock_owner: activeDaemonOwner,
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        lockCalls++;
        if (lockCalls === 1) {
          activeDaemonOwner = 'wrongstack:sess-1';
          return jsonResponse({ ok: false, status: 'conflict', owner: activeDaemonOwner }, 409);
        }
        activeDaemonOwner = body.owner;
        pre2EnteredLock();
        await pre2LockGate;
        return jsonResponse({ ok: true, path: body.path, status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        activeDaemonOwner = undefined;
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const pairA = createWrongTraceHookPair(() => 'sess-1');
    const inputA = { toolName: 'edit', toolInput: { path: 'src/race.ts' } };
    await pairA.preToolUse(inputA);
    const post1Promise = pairA.postToolUse(inputA);
    const pre2Promise = pairA.preToolUse(inputA);
    await pre2InLock;
    releaseHealthGate();
    releasePre2LockGate();
    await Promise.all([post1Promise, pre2Promise]);
    expect(activeDaemonOwner).toBe('wrongstack:sess-1');
    await pairA.postToolUse(inputA);
    expect(activeDaemonOwner).toBeUndefined();

    // Overlapping pre-hooks where pre1 is slow/abandoned and pre2 finishes first
    resetWrongTraceGate();
    let releasePre1Lock!: () => void;
    const pre1LockGate = new Promise<void>((r) => {
      releasePre1Lock = r;
    });
    let pre1Requested!: () => void;
    const pre1Asked = new Promise<void>((r) => {
      pre1Requested = r;
    });
    let caseBLockCount = 0;
    let caseBActiveLocks = 0;

    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') return healthyFileHealth();
      if (u.pathname === '/api/guardrail/lock') {
        caseBLockCount++;
        if (caseBLockCount === 1) {
          pre1Requested();
          await pre1LockGate;
        }
        caseBActiveLocks++;
        return jsonResponse({ ok: true, path: 'src/overlap.ts', status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        caseBActiveLocks = 0;
        return jsonResponse({ ok: true, path: 'src/overlap.ts', status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const baseDir = resolve('proj-norm');
    const pairB = createWrongTraceHookPair(() => 'sess-overlap', { baseDir: () => baseDir });
    const inputB = { toolName: 'edit', toolInput: { path: 'src/overlap.ts' } };
    void pairB.preToolUse(inputB);
    await pre1Asked;
    await pairB.preToolUse(inputB);
    const post2 = pairB.postToolUse(inputB);
    const post1Abandoned = pairB.postToolUse({
      toolName: 'edit',
      toolInput: { path: `${baseDir}/./src/overlap.ts` },
    });
    releasePre1Lock();
    await Promise.all([post2, post1Abandoned]);
    expect(caseBActiveLocks).toBe(0);
  });

  it('waits for an in-flight postToolUse unlockFile before a new preToolUse acquires on the same key and keeps withFileLock best-effort on lock/unlock throws (F72)', async () => {
    resetWrongTraceGate();
    let daemonLockOwner: string | null = null;
    let unlockEnteredResolve!: () => void;
    const unlockEntered = new Promise<void>((r) => {
      unlockEnteredResolve = r;
    });
    let releaseUnlockGate!: () => void;
    const unlockGate = new Promise<void>((r) => {
      releaseUnlockGate = r;
    });
    const opOrder: string[] = [];

    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (u.pathname === '/api/health') return healthyHealth();
      if (u.pathname === '/api/file/health') {
        return jsonResponse({
          path: resolve('src/f72.ts'),
          health_score: 100,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: daemonLockOwner !== null,
          ...(daemonLockOwner ? { lock_owner: daemonLockOwner } : {}),
        });
      }
      if (u.pathname === '/api/guardrail/lock') {
        opOrder.push('lock');
        daemonLockOwner = String(body.owner ?? 'wrongstack:sess-f72');
        return jsonResponse({ ok: true, path: body.path, status: 'locked' });
      }
      if (u.pathname === '/api/guardrail/unlock') {
        opOrder.push('unlock:start');
        unlockEnteredResolve();
        await unlockGate;
        opOrder.push('unlock:done');
        daemonLockOwner = null;
        return jsonResponse({ ok: true, path: body.path, status: 'unlocked' });
      }
      return jsonResponse({});
    });

    const pair = createWrongTraceHookPair(() => 'sess-f72');
    const input = { toolName: 'edit', toolInput: { path: 'src/f72.ts' } };

    await pair.preToolUse(input);
    const post1 = pair.postToolUse(input);
    await unlockEntered;

    const pre2 = pair.preToolUse(input);
    await new Promise((r) => setTimeout(r, 15));
    expect(opOrder).toEqual(['lock', 'unlock:start']);

    releaseUnlockGate();
    await Promise.all([post1, pre2]);
    expect(opOrder).toEqual(['lock', 'unlock:start', 'unlock:done', 'lock']);
    expect(daemonLockOwner).toBe('wrongstack:sess-f72');

    await pair.postToolUse(input);
    expect(daemonLockOwner).toBeNull();

    // withFileLock best-effort resilience when lockFile or unlockFile throws
    const { getWrongTrace, withFileLock } = await import('../gate.js');
    const wt = await getWrongTrace();
    const origLock = wt.lockFile.bind(wt);
    const origUnlock = wt.unlockFile.bind(wt);
    try {
      wt.lockFile = async () => {
        throw new Error('simulated lockFile transport throw');
      };
      await expect(withFileLock('src/f72.ts', 'test', async () => 'ran')).resolves.toBe('ran');

      wt.lockFile = origLock;
      wt.unlockFile = async () => {
        throw new Error('simulated unlockFile transport throw');
      };
      await expect(withFileLock('src/f72.ts', 'test', async () => 'done')).resolves.toBe('done');
    } finally {
      wt.lockFile = origLock;
      wt.unlockFile = origUnlock;
    }
  });
});
