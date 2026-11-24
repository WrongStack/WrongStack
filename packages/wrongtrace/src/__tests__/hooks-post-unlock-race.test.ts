import { afterEach, describe, expect, it } from 'vitest';
import { resetWrongTraceGate } from '../gate.js';
import { createWrongTraceHookPair } from '../hooks.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env['WRONGTRACE_URL'];
  resetWrongTraceGate();
});

describe('WrongTrace postToolUse cross-session unlock race', () => {
  it('does not let a stale raced postToolUse unlock another session active daemon lock', async () => {
    resetWrongTraceGate();
    process.env['WRONGTRACE_URL'] = 'http://localhost:3999';

    let daemonOwner: string | undefined;
    let forceNextLock409 = false;
    let holdNextHealth = false;
    let healthGate: ReturnType<typeof deferred<Response>> | undefined;
    let healthGateReady: ReturnType<typeof deferred<void>> | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, socket_path: '' }), { status: 200 });
      }
      if (url.endsWith('/api/guardrail/lock')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { owner?: string };
        if (forceNextLock409) {
          forceNextLock409 = false;
          return new Response(JSON.stringify({ ok: false, error: 'locked' }), { status: 409 });
        }
        if (daemonOwner && daemonOwner !== body.owner) {
          return new Response(JSON.stringify({ ok: false, error: 'locked' }), { status: 409 });
        }
        daemonOwner = body.owner;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/guardrail/unlock')) {
        daemonOwner = undefined;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/api/file/health')) {
        if (holdNextHealth) {
          holdNextHealth = false;
          healthGate = deferred<Response>();
          healthGateReady?.resolve();
          return healthGate.promise;
        }
        return new Response(
          JSON.stringify({ is_locked: Boolean(daemonOwner), lock_owner: daemonOwner }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const pair = createWrongTraceHookPair({
      sessionId: () => 'sess-1',
      cwd: () => '/tmp/project',
    });

    await pair.preToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });
    forceNextLock409 = true;
    await pair.preToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });
    await pair.postToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });

    holdNextHealth = true;
    healthGateReady = deferred<void>();
    const post2 = pair.postToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });
    await healthGateReady.promise;

    await pair.preToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });
    await pair.postToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-1',
    });
    await pair.preToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-2',
    });
    expect(daemonOwner).toBe('wrongstack:sess-2');

    healthGate!.resolve(
      new Response(JSON.stringify({ is_locked: true, lock_owner: 'wrongstack:sess-1' }), {
        status: 200,
      }),
    );
    await post2;
    expect(daemonOwner).toBe('wrongstack:sess-2');

    await pair.postToolUse({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/a.ts' },
      sessionId: 'sess-2',
    });
    expect(daemonOwner).toBeUndefined();
  });

  it("does not let another session's lost lock race keep a finished session's lock until the TTL", async () => {
    resetWrongTraceGate();
    process.env['WRONGTRACE_URL'] = 'http://localhost:3999';

    let daemonOwner: string | undefined;
    let unlockCalls = 0;
    let next503Lock = false;
    let parkNextLock:
      | { arrived: ReturnType<typeof deferred<void>>; gate: Promise<void> }
      | undefined;
    let parkNextHealth:
      | { arrived: ReturnType<typeof deferred<void>>; gate: Promise<void> }
      | undefined;

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, socket_path: '' }), { status: 200 });
      }
      if (url.includes('/api/file/health')) {
        const park = parkNextHealth;
        if (park) {
          parkNextHealth = undefined;
          park.arrived.resolve();
          await park.gate;
        }
        return new Response(
          JSON.stringify({ is_locked: Boolean(daemonOwner), lock_owner: daemonOwner }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/guardrail/lock')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { owner?: string };
        const park = parkNextLock;
        if (park) {
          parkNextLock = undefined;
          park.arrived.resolve();
          await park.gate;
        }
        if (daemonOwner && daemonOwner !== body.owner) {
          return new Response(JSON.stringify({ ok: false, error: 'locked' }), { status: 409 });
        }
        daemonOwner = body.owner;
        if (next503Lock) {
          // The daemon took the lock but the reply was lost (ambiguous outcome).
          next503Lock = false;
          return new Response('{}', { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/guardrail/unlock')) {
        unlockCalls++;
        daemonOwner = undefined;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const pair = createWrongTraceHookPair(() => 'unused');
    const edit = (sessionId: string) => ({
      toolName: 'edit',
      toolInput: { path: '/tmp/project/shared.ts' },
      sessionId,
    });

    // sess-2 passes the pre-flight; its lock request is still in flight.
    const s2LockArrived = deferred<void>();
    const s2LockGate = deferred<void>();
    parkNextLock = { arrived: s2LockArrived, gate: s2LockGate.promise };
    const s2Pre = pair.preToolUse(edit('sess-2'));
    await s2LockArrived.promise;

    // sess-1 takes the lock; the reply is lost, so its claim counts as a race.
    next503Lock = true;
    await pair.preToolUse(edit('sess-1'));
    expect(daemonOwner).toBe('wrongstack:sess-1');

    // sess-1 finished; its release is checking who owns the lock.
    const healthArrived = deferred<void>();
    const healthGate = deferred<void>();
    parkNextHealth = { arrived: healthArrived, gate: healthGate.promise };
    const s1Post = pair.postToolUse(edit('sess-1'));
    await healthArrived.promise;

    // sess-2's lock request now loses to sess-1 (409): it acquired nothing.
    s2LockGate.resolve();
    await s2Pre;

    healthGate.resolve();
    await s1Post;
    expect(unlockCalls).toBe(1);
    expect(daemonOwner).toBeUndefined();

    await pair.postToolUse(edit('sess-2'));
    await expect(pair.preToolUse(edit('sess-2'))).resolves.toEqual({ action: 'allow' });
    expect(daemonOwner).toBe('wrongstack:sess-2');
  });
});
