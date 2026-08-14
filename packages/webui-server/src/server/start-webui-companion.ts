import * as http from 'node:http';

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
export function setupCompanionServer(
  httpServer: http.Server,
  wsHost: string | undefined,
  httpPort: number,
): http.Server | null {
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
    // Throwing from an EventEmitter handler becomes an `uncaughtException`
    // and kills the process. This listener is explicitly best-effort — the
    // primary is already bound and serving by now — so an unexpected errno
    // must not take the whole WebUI down after the "server running" banner
    // has already printed.
    const expected =
      err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE';
    if (!expected) {
      console.warn(
        `[WebUI] companion listener on ${companionLabel} failed (${err.code ?? 'unknown'}): ` +
          `${err.message}. The primary address is unaffected.`,
      );
    }
  });
  companionServer.listen(httpPort, companion, () => {
    console.log(`[WebUI] HTTP server running on http://${companionLabel}:${httpPort}`);
  });
  return companionServer;
}
