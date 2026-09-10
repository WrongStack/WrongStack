/**
 * WS-006 — `wstack acp --ws` connection admission.
 *
 * The transport used to admit anything. The Origin check was `if (origin && …)`
 * so every non-browser client skipped it, and `handleAuthenticate` returns
 * success unconditionally, so any local process could open a socket on the fixed
 * loopback port and drive a full agent — tool execution, shell, arbitrary `cwd`.
 *
 * The existing runtime smoke test (acp-ws-runtime.test.ts) replicates the
 * handler wiring rather than calling it, so it would not have caught this. These
 * exercise the gate directly.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAcpConnectionGate } from '../src/subcommands/handlers/acp-connection-gate.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 8889;
const TOKEN = 'a'.repeat(64);

const gate = createAcpConnectionGate({ host: HOST, port: PORT, token: TOKEN });

function req(
  headers: Record<string, string | undefined>,
  url = '/',
): Pick<IncomingMessage, 'headers' | 'url'> {
  return { headers, url } as unknown as Pick<IncomingMessage, 'headers' | 'url'>;
}

const withToken = (extra: Record<string, string | undefined> = {}) =>
  req({ host: `${HOST}:${PORT}`, ...extra }, `/?token=${TOKEN}`);

describe('ACP WebSocket connection gate', () => {
  it('admits a tokened loopback client with no Origin (the normal ACP case)', () => {
    expect(gate.check(withToken(), 0).ok).toBe(true);
  });

  it('admits a client presenting the token as a bearer header', () => {
    const verdict = gate.check(
      req({ host: `${HOST}:${PORT}`, authorization: `Bearer ${TOKEN}` }),
      0,
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a tokenless client — the local-process foothold', () => {
    const verdict = gate.check(req({ host: `${HOST}:${PORT}` }), 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unauthorized');
  });

  it('rejects a wrong token', () => {
    const verdict = gate.check(req({ host: `${HOST}:${PORT}` }, '/?token=nope'), 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unauthorized');
  });

  it('rejects a token of the right length but wrong bytes', () => {
    const verdict = gate.check(req({ host: `${HOST}:${PORT}` }, `/?token=${'b'.repeat(64)}`), 0);
    expect(verdict.ok).toBe(false);
  });

  it('rejects a foreign browser Origin before looking at the token', () => {
    const verdict = gate.check(
      req({ host: `${HOST}:${PORT}`, origin: 'https://evil.example' }, `/?token=${TOKEN}`),
      0,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('cross-origin forbidden');
  });

  it('rejects a rebound Host header even with a valid token', () => {
    const verdict = gate.check(req({ host: 'evil.example' }, `/?token=${TOKEN}`), 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('untrusted host header');
  });

  it('rejects a missing Host header', () => {
    const verdict = gate.check(req({}, `/?token=${TOKEN}`), 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('untrusted host header');
  });

  it('accepts localhost and ::1 Host forms', () => {
    for (const host of [`localhost:${PORT}`, `[::1]:${PORT}`]) {
      expect(gate.check(withToken({ host }), 0).ok).toBe(true);
    }
  });

  it('caps concurrent connections', () => {
    const capped = createAcpConnectionGate({
      host: HOST,
      port: PORT,
      token: TOKEN,
      maxConnections: 2,
    });
    expect(capped.check(withToken(), 1).ok).toBe(true);
    const verdict = capped.check(withToken(), 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe(1013);
  });
});

describe('the gate is wired at the handshake, not after it (WS-001)', () => {
  /**
   * A unit test proves the gate refuses the right connections. It cannot prove
   * WHEN it refuses them, and that was the whole finding: the gate was correct
   * and ran on the `connection` event, i.e. after `ws` had already answered
   * `101 Switching Protocols`, allocated a WebSocket with a 20 MiB
   * `maxPayload` budget and spent a file descriptor. A WebSocket handshake is
   * exempt from the same-origin policy, so any open page could run
   * `for(;;) new WebSocket('ws://127.0.0.1:<acpPort>')` and make the agent host
   * pay that allocation per attempt.
   *
   * Measured before the fix: the client reached `open` and the server emitted
   * `connection`. After: the client gets HTTP 403 during the handshake and the
   * server never emits `connection`.
   */
  const SOURCE = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/subcommands/handlers/acp.ts'),
    'utf8',
  );

  it('constructs the WebSocketServer with a verifyClient option', () => {
    expect(SOURCE).toMatch(/new WebSocketServer\(\{[^}]*verifyClient/);
  });

  it('does not call gate.check from the connection handler', () => {
    // The check moved; a copy left behind on `connection` would restore the
    // per-attempt allocation while looking harmless next to the new one.
    const connectionHandler = /wss\.on\('connection',([\s\S]*?)\n  \}\);/.exec(SOURCE);
    expect(connectionHandler, 'expected a wss.on(connection, …) handler to inspect').not.toBeNull();
    expect(connectionHandler![1]).not.toContain('gate.check');
  });

  it('refuses during the handshake rather than with a close frame', () => {
    // 1008 is a WebSocket close code and means nothing to a client that has not
    // completed an upgrade; the refusal has to be an HTTP status.
    expect(SOURCE).toMatch(/cb\(false, 403/);
  });
});
