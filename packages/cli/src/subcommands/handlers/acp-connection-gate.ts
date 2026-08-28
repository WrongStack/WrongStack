/**
 * Connection admission for `wstack acp --ws` (WS-006).
 *
 * The WebSocket transport previously admitted anything: the Origin check was
 * `if (origin && …)`, so a client that sends no Origin — which is every
 * non-browser client — skipped it entirely, and `handleAuthenticate` returns
 * success unconditionally. Any local process could open a socket on the fixed
 * loopback port and drive a full agent: tool execution, shell, arbitrary `cwd`.
 *
 * The gate lives here rather than inline in the handler so it can be tested
 * directly. The handler wiring is replicated (not called) by the existing
 * runtime smoke test, so an inline predicate would have had no coverage at all.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

interface AcpGateVerdict {
  ok: boolean;
  /** WebSocket close code to send when `ok` is false. */
  code?: number;
  reason?: string;
}

const OK: AcpGateVerdict = { ok: true };

interface AcpConnectionGateOptions {
  host: string;
  port: number;
  token: string;
  /** Concurrent connection ceiling. */
  maxConnections?: number;
}

interface AcpConnectionGate {
  /** Decide whether to admit a handshake. Does not mutate connection count. */
  check(req: Pick<IncomingMessage, 'headers' | 'url'>, liveConnections: number): AcpGateVerdict;
}

function isLoopbackHostHeader(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) return false;
  try {
    const hostname = new URL(`http://${trimmed}`).hostname.toLowerCase();
    const bare =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
  } catch {
    return false;
  }
}

export function createAcpConnectionGate(opts: AcpConnectionGateOptions): AcpConnectionGate {
  const { host, port, token } = opts;
  const maxConnections = opts.maxConnections ?? 8;
  const expected = Buffer.from(token);

  const tokenFromRequest = (req: Pick<IncomingMessage, 'headers' | 'url'>): string | undefined => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    try {
      return (
        new URL(req.url ?? '/', `http://${host}:${port}`).searchParams.get('token') ?? undefined
      );
    } catch {
      return undefined;
    }
  };

  const tokenOk = (supplied: string | undefined): boolean => {
    if (!supplied) return false;
    const a = Buffer.from(supplied);
    // Length is not secret; comparing unequal-length buffers throws.
    if (a.length !== expected.length) return false;
    return timingSafeEqual(a, expected);
  };

  return {
    check(req, liveConnections) {
      // Real ACP clients send no Origin. A browser always does, so a present
      // Origin that is not this server means a web page is dialling in.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}:${port}` && origin !== `ws://${host}:${port}`) {
        return { ok: false, code: 1008, reason: 'cross-origin forbidden' };
      }
      // DNS-rebinding guard: on a loopback bind the Host must itself be loopback.
      if (!isLoopbackHostHeader(req.headers.host ?? '')) {
        return { ok: false, code: 1008, reason: 'untrusted host header' };
      }
      if (!tokenOk(tokenFromRequest(req))) {
        return { ok: false, code: 1008, reason: 'unauthorized' };
      }
      if (liveConnections >= maxConnections) {
        return { ok: false, code: 1013, reason: 'too many connections' };
      }
      return OK;
    },
  };
}
