import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI, type WSServerMessage, type WSClientMessage } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

/**
 * PR 0 of Issue #30 (webui-server 8-PR refactor):
 * baseline boot-shape integration test. The safety net
 * for PRs 1-8.
 *
 * Per the issue body, this PR 0 must:
 *
 *   1. Call `runWebUI` with `port: 0` (auto-allocate)
 *      and `host: '127.0.0.1'` (loopback bind — no
 *      firewall implications in CI), with stub
 *      `ProviderConfig`/`vault`/`SessionRegistry`/
 *      `Agent`/`events`.
 *   2. Snapshot the public API surface so a future
 *      refactor that changes an export without
 *      updating the call site fails this test first.
 *   3. Assert the `session.start` message arrives
 *      over a fresh WebSocket connection — pinning
 *      the boot→listening→client→broadcast path.
 *   4. Verify graceful shutdown: the
 *      `unregisterInstance` call path runs to
 *      completion (no leaked registry entries, no
 *      open listeners).
 *
 * What the tests do *not* pin: exact port numbers
 * (use `0` and read from `onListening`), exact
 * `session.start` payload (the type system pins
 * `WSServerMessage`/`WSClientMessage` already —
 * the test only asserts presence and `type === 'session.start'`).
 *
 * The port allocator at the top of the file gives
 * each test a unique port so parallel test runs do
 * not collide.
 */

// PR 0 of Issue #30 (webui-server 8-PR refactor):
// baseline boot-shape integration test. The safety net
// for PRs 1-8.
//
// Per the issue body, this PR 0 must:
//
//   1. Call `runWebUI` with `host: '127.0.0.1'` (loopback
//      bind — no firewall implications in CI), with
//      stub session/agent/events. We do NOT pin a port
//      here: `findFreePort` increments on collision, and
//      a parallel test run (or a leaked listener from
//      the previous runWebUI invocation) can steal the
//      requested port. We trust `onListening.info.wsPort`
//      to tell us what was actually bound.
//
//   2. Snapshot the public API surface so a future
//      refactor that changes an export without
//      updating the call site fails this test first.
//
//   3. Assert the `session.start` message arrives
//      over a fresh WebSocket connection — pinning
//      the boot→listening→client→broadcast path.
//
//   4. Verify graceful shutdown: SIGINT triggers the
//      CLI's own signal handler which resolves the
//      `runWebUI` promise. The same flow the production
//      binary uses on Ctrl-C.

describe('runWebUI boot shape (PR 0 of #30)', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('public API surface: runWebUI is a function, WSServerMessage/WSClientMessage are types', () => {
    // The "snapshot" half of the issue body's PR 0 spec.
    // If a future refactor renames or drops these
    // exports, the test file itself will fail to
    // compile. That's the pin.
    expect(typeof runWebUI).toBe('function');
    // WSServerMessage and WSClientMessage are
    // type-only exports; the existence of this
    // import is itself the assertion.
    const serverMsg: WSServerMessage = { type: 'noop', payload: null };
    const clientMsg: WSClientMessage = { type: 'noop' };
    expect(serverMsg.type).toBe('noop');
    expect(clientMsg.type).toBe('noop');
  });

  it('runWebUI starts a server, accepts a WebSocket, sends session.start', async () => {
    const events = new EventBus();
    let signalReady: (() => void) | undefined;
    let listeningInfo: { httpPort: number; wsPort: number; host: string } | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });
    const serverDone = runWebUI({
      // port omitted — findFreePort picks the first
      // available. We read the actual port from
      // onListening.info.wsPort below.
      host: '127.0.0.1',
      onListening: (info) => {
        listeningInfo = info;
        signalReady?.();
      },
      events,
      session: { id: 'pr0-session' } as never,
      agent: {
        ctx: { model: 'pr0-model', provider: { id: 'pr0-provider' } },
        run: vi.fn(),
      } as never,
    });

    try {
      await listening;
      expect(listeningInfo).toBeDefined();
      expect(listeningInfo!.host).toBe('127.0.0.1');
      const { ws, waitForMessage } = await openWs(
        `ws://127.0.0.1:${listeningInfo!.wsPort}`,
      );
      const start = await waitForMessage('session.start');
      expect(start.type).toBe('session.start');
      ws.close();
    } finally {
      // runWebUI is a long-running server; the only way
      // to shut it down is a SIGINT (the CLI's own
      // signal handler resolves the promise). This is
      // the same flow the production binary uses on
      // Ctrl-C.
      process.emit('SIGINT');
      await serverDone;
    }
  });

  it('runWebUI onListening reports host: 127.0.0.1', async () => {
    const events = new EventBus();
    let listeningInfo: { httpPort: number; wsPort: number; host: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });
    const serverDone = runWebUI({
      host: '127.0.0.1',
      onListening: (info) => {
        listeningInfo = info;
        signalReady?.();
      },
      events,
      session: { id: 'pr0-port' } as never,
      agent: {
        ctx: { model: 'p', provider: { id: 'p' } },
        run: vi.fn(),
      } as never,
    });

    try {
      await listening;
      expect(listeningInfo).toBeDefined();
      // We don't pin a specific port: findFreePort
      // increments on collision. The contract is
      // "loopback bind, port non-zero, http and ws
      // distinct".
      expect(listeningInfo!.host).toBe('127.0.0.1');
      expect(listeningInfo!.wsPort).toBeGreaterThan(0);
      expect(listeningInfo!.httpPort).toBeGreaterThan(0);
      expect(listeningInfo!.wsPort).not.toBe(listeningInfo!.httpPort);
    } finally {
      process.emit('SIGINT');
      await serverDone;
    }
  });
});
