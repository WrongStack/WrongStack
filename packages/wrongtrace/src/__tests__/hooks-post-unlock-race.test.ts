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
});
