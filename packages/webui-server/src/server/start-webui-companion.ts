import * as http from 'node:http';
import { listenWithRetry } from './port-utils.js';

/**
 * Dual-stack / IPv6 companion listener.
 *
 * When the primary bind is IPv4-only, also try the IPv6 equivalent so
 * peers using IPv6 can connect. Tailscale assigns both v4 (100.x.x.x)
 * and v6 (fd7a:…) addresses; Chrome/Edge on Windows resolve `localhost`
 * to [::1] before 127.0.0.1. Without the companion listener, a v4-only
 * bind causes ECONNREFUSED for all IPv6 peers.
 *
 * When the primary bind is IPv6-only (::), try the IPv4 companion as a
 * fallback for systems where `::` does not accept IPv4-mapped
 * connections (net.ipv6.bindv6only=1, some Windows configs).
 */
export async function setupCompanionServer(
  httpServer: http.Server,
  wsHost: string | undefined,
  /**
   * The port the PRIMARY server actually bound — not the originally
   * requested port. The companion must mirror it exactly: advertised URLs
   * point at the primary's port, so a companion bound elsewhere would be
   * unreachable dead weight. A single bind attempt; EADDRINUSE here means
   * the mirror is impossible, so the companion degrades to null.
   */
  httpPort: number,
): Promise<http.Server | null> {
  const companion =
    wsHost === '127.0.0.1'
      ? '::1'
      : wsHost === '0.0.0.0' || wsHost === undefined
        ? '::'
        : wsHost === '::' || wsHost === '[::]'
          ? '0.0.0.0'
          : null;
  if (!companion) return null;

  const companionLabel = companion.includes(':') ? `[${companion}]` : companion;
  // A single http.Server cannot bind two addresses. Calling .listen() a
  // second time either throws ERR_SERVER_ALREADY_LISTEN (when the first
  // bind has completed) or silently overwrites the first (when both
  // calls run in the same synchronous tick — which is exactly this case).
  // Create a separate server that shares the request handler, and forward
  // 'upgrade' events so the WebSocketServer on the primary also serves WS
  // connections arriving on the companion address.
  const companionServer = http.createServer();
  companionServer.on('request', (req, res) => httpServer.emit('request', req, res));
  companionServer.on('upgrade', (req, socket, head) =>
    httpServer.emit('upgrade', req, socket, head),
  );
  companionServer.on('error', (err: NodeJS.ErrnoException) => {
    // Late runtime errors only — bind-time failures are handled by the
    // awaited listenWithRetry below. Throwing from an EventEmitter handler
    // becomes an `uncaughtException` and kills the process; this listener
    // is best-effort because the primary is already bound and serving.
    const expected = err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL';
    if (!expected) {
      console.warn(
        `[WebUI] companion listener on ${companionLabel} failed (${err.code ?? 'unknown'}): ` +
          `${err.message}. The primary address is unaffected.`,
      );
    }
  });
  // The companion never advances ports (it must mirror the primary's bound
  // port — see the param doc), so this is a single attempt: EADDRINUSE and
  // any other bind error reject, are warned once, and downgrade to "no
  // companion" instead of crashing or binding an unreachable port.
  try {
    await listenWithRetry(companionServer, companion, httpPort, { maxTries: 1 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
    console.warn(
      `[WebUI] companion listener on ${companionLabel} not started (${code}): ` +
        `${(err as Error)?.message ?? err}. The primary address is unaffected.`,
    );
    return null;
  }
  console.log(`[WebUI] HTTP server running on http://${companionLabel}:${httpPort}`);
  return companionServer;
}
