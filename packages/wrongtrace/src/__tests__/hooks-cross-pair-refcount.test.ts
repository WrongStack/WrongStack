import { afterEach, describe, expect, it } from 'vitest';
import { resetWrongTraceGate } from '../gate.js';
import { createWrongTraceHookPair } from '../hooks.js';

/**
 * The refcount contract (hooks.ts "Per-runner lock bookkeeping") promises the
 * daemon lock is released only when the LAST in-flight edit finishes. Production
 * wires two pairs for ONE owner: the standalone WebUI builds a leader pair
 * (standalone-hooks.ts) and a worker pair (standalone-delegation.ts), both
 * stamping `wrongstack:<session.id>`.
 *
 * F2350: each pair used to allocate its own counter map, so the first finisher
 * reached zero in its own bookkeeping and unlocked the path while the sibling's
 * edit was still running.
 */
const SESSION = 'sess-shared';
const FILE = '/tmp/project/shared.ts';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env['WRONGTRACE_URL'];
  resetWrongTraceGate();
});

describe('WrongTrace cross-pair lock reference count (F2350)', () => {
  it('keeps the daemon lock until the last finisher of two same-owner pairs', async () => {
    resetWrongTraceGate();
    process.env['WRONGTRACE_URL'] = 'http://localhost:3999';

    let daemonOwner: string | undefined;
    let unlockCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, socket_path: '' }), { status: 200 });
      }
      if (url.includes('/api/file/health')) {
        return new Response(
          JSON.stringify({ is_locked: Boolean(daemonOwner), lock_owner: daemonOwner }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/guardrail/lock')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { owner?: string };
        if (daemonOwner && daemonOwner !== body.owner) {
          return new Response(JSON.stringify({ ok: false, error: 'locked' }), { status: 409 });
        }
        daemonOwner = body.owner;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/api/guardrail/unlock')) {
        unlockCalls++;
        daemonOwner = undefined;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const edit = { toolName: 'edit', toolInput: { path: FILE }, sessionId: SESSION };
    // The two production pairs — same owner (`() => session.id`).
    const leader = createWrongTraceHookPair(() => SESSION);
    const workers = createWrongTraceHookPair(() => SESSION);

    await leader.preToolUse(edit);
    await workers.preToolUse(edit);

    // The leader is a sibling that finishes early; the worker is still editing.
    await leader.postToolUse(edit);
    expect(daemonOwner).toBe(`wrongstack:${SESSION}`);

    await workers.postToolUse(edit);
    expect(daemonOwner).toBeUndefined();
    expect(unlockCalls).toBe(1);
  });
});
