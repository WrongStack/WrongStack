/**
 * Process lifecycle for the WebUI server: graceful shutdown and the
 * SIGINT/SIGTERM wiring that triggers it.
 *
 * On a termination signal we (best-effort) flush + close the active session,
 * close every connected WebSocket, stop the HTTP and WS servers, then exit.
 * A re-entrancy guard makes a second signal during shutdown a no-op (rapid
 * double Ctrl+C no longer runs the teardown twice).
 *
 * Extracted from `index.ts` as a parameterized factory so the teardown
 * sequence can be unit tested without a real process signal, server, or
 * `process.exit` — `log` and `exit` are injectable seams.
 */

interface LifecycleResources {
  /** Persist + close the active session (best-effort; errors are logged). */
  flushSession: () => Promise<void>;
  /**
   * Returns the currently-connected client sockets to close. A thunk (not a
   * snapshot) so shutdown closes whoever is connected *at signal time*, not
   * whoever was connected when the handler was registered.
   */
  /**
   * Live client sockets. `terminate` is optional so a test double can supply
   * `close` alone, but a real `ws` socket has it — and the shutdown path needs
   * it: `close()` only starts a handshake the peer may never answer.
   */
  clients: () => Iterable<{ close: () => void; terminate?: (() => void) | undefined }>;
  /** Servers to stop (HTTP + WS). `null`/`undefined` entries are skipped. */
  servers: Array<{ close: () => void } | null | undefined>;
  /**
   * Optional best-effort cleanup run after the session flush and before exit
   * (e.g. removing this process from the running-instance registry). Errors are
   * logged, never thrown — cleanup must not block a clean shutdown.
   */
  onShutdown?: (() => Promise<void> | void) | undefined;
  /**
   * Fires **before** any HTTP/WS servers close. Use this for cleanup that must
   * finish while the network is still up — e.g. telling a Kanban supervisor
   * to flush its periodic tick so no in-flight `kanban.*` broadcast races a
   * `WebSocketServer.close()`.
   */
  onPreShutdown?: (() => Promise<void> | void) | undefined;
  /** Output sink. Defaults to `console.log`. */
  log?: ((msg: string) => void) | undefined;
  /** Process exit. Defaults to `process.exit`. Injectable for tests. */
  exit?: ((code: number) => void) | undefined;
}

/**
 * Build the graceful-shutdown handler. Returns an idempotent async function:
 * the first call runs the teardown, subsequent calls (e.g. a second SIGINT)
 * return immediately.
 */
export function createShutdown(res: LifecycleResources): () => Promise<void> {
  const log = res.log ?? ((m: string) => console.log(m));
  const exit = res.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) return; // a second signal during teardown is a no-op
    shuttingDown = true;

    log('[WebUI] Shutting down...');
    try {
      await res.flushSession();
    } catch (e) {
      log(`[WebUI] Error closing session: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Destroy, then close. `ws.close()` starts a CLOSE handshake — the socket
    // only goes away once the peer replies, or after `ws`'s internal 30 s
    // timeout — while `net.Server.close()` waits for every open connection.
    // A client behind a dropped VPN or a half-open TCP connection never
    // acknowledges, so the pair could hang the whole teardown. `exit(0)` below
    // currently papers over it; any caller that injects a non-exiting `exit`
    // seam, or a future refactor that awaits the close callbacks, would block.
    for (const ws of res.clients()) {
      try {
        ws.close();
        ws.terminate?.();
      } catch {
        // Already gone.
      }
    }
    if (res.onPreShutdown) {
      try {
        await res.onPreShutdown();
      } catch (e) {
        log(
          `[WebUI] Error during pre-shutdown cleanup: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    for (const server of res.servers) server?.close();
    if (res.onShutdown) {
      try {
        await res.onShutdown();
      } catch (e) {
        log(`[WebUI] Error during shutdown cleanup: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    exit(0);
  };
}

/**
 * Register the shutdown handler on SIGINT and SIGTERM. Returns an unregister
 * function that detaches both listeners (useful for tests and clean restarts).
 */
export function registerShutdownHandlers(res: LifecycleResources): () => void {
  const shutdown = createShutdown(res);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
}
