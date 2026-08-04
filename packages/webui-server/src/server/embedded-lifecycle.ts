import * as path from 'node:path';
import {
  registerInstance,
  unregisterInstance,
  type WebUIInstanceRecord,
} from './instance-registry.js';
import { formatExternalAccessUrls } from './network-info.js';
import { openBrowser } from './open-browser.js';
import type { SurfaceKind } from './port-utils.js';
import { buildWebUIAccessUrl } from './ws-utils.js';

/**
 * PR 7 of Issue #30 (webui-server 8-PR refactor): process lifecycle.
 *
 * Three concerns pulled out of the ~3000-line `runWebUI` body:
 *
 *   - `registerWebuiInstance` — record this embedded WebUI in the shared
 *     running-instance registry (so `wstack --webui --list` sees it).
 *   - `announceWebuiReady` — log the ready banner and pop the browser
 *     once the HTTP server is listening.
 *   - `createWebuiShutdown` + `registerWebuiSignalHandlers` — the
 *     SIGINT/SIGTERM teardown sequence.
 *
 * Each external dependency (registry IO, browser launch) is an
 * injectable seam so the orchestration can be unit-tested without
 * touching disk or spawning a browser. Run-loop state (abort
 * controllers, client map, the run promise's `resolve`) stays in
 * `webui-server.ts` and is threaded in as callbacks — the module never
 * captures it.
 */

// ── Instance registry ────────────────────────────────────────────────

export interface RegisterWebuiInstanceParams {
  pid: number;
  /** Surface kind — 'webui' or 'simpleui'. */
  surface: SurfaceKind;
  host: string;
  /** Port serving both HTTP and WebSocket (single-port design). */
  httpPort: number;
  /** Browser-facing public URL when served through a tunnel/proxy. */
  publicUrl?: string | undefined;
  projectRoot: string;
  /** ISO timestamp when the instance registered. */
  startedAt: string;
  /** Registry base dir (dirname of globalConfigPath); undefined ⇒ registry default. */
  registryBaseDir: string | undefined;
  /**
   * This instance's API access token, recorded so a same-project TUI/REPL can
   * authenticate `POST /api/fleet/ping` (H3). See `WebUIInstanceRecord`.
   */
  authToken?: string | undefined;
}

export interface RegisterWebuiInstanceDeps {
  registerFn?: (record: WebUIInstanceRecord, baseDir?: string) => Promise<void>;
}

/**
 * Fire-and-forget registration of this WebUI in the running-instance
 * registry. Best-effort: a registry write error never blocks startup and
 * is swallowed (the registry is a convenience index, not a source of
 * truth). Caller guards on `projectRoot` being known.
 */
export function registerWebuiInstance(
  p: RegisterWebuiInstanceParams,
  deps: RegisterWebuiInstanceDeps = {},
): void {
  const register = deps.registerFn ?? registerInstance;
  void register(
    {
      pid: p.pid,
      surface: p.surface,
      httpPort: p.httpPort,
      host: p.host,
      projectRoot: p.projectRoot,
      projectName: path.basename(p.projectRoot) || p.projectRoot,
      startedAt: p.startedAt,
      url: buildWebUIAccessUrl({
        host: p.host,
        port: p.httpPort,
        publicUrl: p.publicUrl,
      }),
      ...(p.authToken ? { authToken: p.authToken } : {}),
    },
    p.registryBaseDir,
  ).catch(() => {});
}

// ── Ready banner + open browser ──────────────────────────────────────

export interface AnnounceWebuiReadyParams {
  /** Surface kind — 'webui' or 'simpleui'. */
  surface: SurfaceKind;
  /** The HTTP server (StaticServeHandle.server). */
  server: { on: (event: 'listening', cb: () => void) => void };
  host: string;
  /** Port serving both HTTP and WebSocket. */
  httpPort: number;
  open: boolean;
  /** Auth token for WS connections. Included in the URL so the frontend can exchange it for an HttpOnly cookie via /ws-auth. */
  wsToken?: string;
  /** Browser-facing public URL when served through a tunnel/proxy. */
  publicUrl?: string | undefined;
  log?: (msg: string) => void;
  openBrowserFn?: (url: string) => void;
}

/**
 * Once the HTTP server is listening, print the ready banner and (if
 * `open`) launch the browser at the served URL.
 */
export function announceWebuiReady(p: AnnounceWebuiReadyParams): void {
  const log = p.log ?? ((m: string) => console.log(m));
  const launch = p.openBrowserFn ?? openBrowser;
  // Include the auth token in the URL so the frontend can exchange it for an
  // HttpOnly cookie. Wildcard binds are printed as a local browser URL because
  // http://0.0.0.0 is not navigable.
  const openUrl = buildWebUIAccessUrl({
    host: p.host,
    port: p.httpPort,
    token: p.wsToken,
    publicUrl: p.publicUrl,
  });
  p.server.on('listening', () => {
    const extraUrls = formatExternalAccessUrls({
      bindHost: p.host,
      port: p.httpPort,
      token: p.wsToken,
      publicUrl: p.publicUrl,
    });
    const extraBlock =
      extraUrls.length > 0
        ? `\n  Also reachable on external interfaces:\n${extraUrls.join('\n')}\n`
        : '';
    log(
      `\n  ▸ ${p.surface === 'webui' ? 'WebUI' : 'SimpleUI'} ready — open \x1b[1m${openUrl}\x1b[0m in your browser` +
        `    (same agent as this terminal)\n${extraBlock}`,
    );
    if (p.open) launch(openUrl);
  });
}

// ── Graceful shutdown (SIGINT/SIGTERM) ───────────────────────────────

export interface WebuiShutdownResources {
  /** Abort every in-flight run (legacy single slot + per-socket controllers) and clear them. */
  abortInFlight: () => void;
  /** Run and drop every event-bus unsubscriber. */
  unsubscribeEvents: () => void;
  /** Dispose long-lived handlers, timers, watchers, and project services owned by the host. */
  disposeResources?: (() => void) | undefined;
  /** Close every connected socket and clear the client map. */
  closeClients: () => void;
  /** Close the static HTTP server (no-op when WS-only). */
  closeHttpServer: () => void;
  /** The WebSocket server to stop (its close callback resolves the run promise). */
  wss: { close: (cb?: () => void) => void };
  /** This process's pid — the registry liveness key. */
  pid: number;
  /** Registry base dir (undefined ⇒ registry default). */
  registryBaseDir: string | undefined;
  /** Called once teardown settles — wired to the run promise's `resolve`. */
  onStopped: () => void;
  log?: (msg: string) => void;
  debug?: (msg: string) => void;
  /** Injectable for tests; defaults to the real registry unregister. */
  unregisterFn?: (pid: number, baseDir?: string) => Promise<void>;
}

/**
 * Build the SIGINT/SIGTERM teardown handler. The returned function is
 * idempotent: the first call runs the teardown, later calls (e.g. a
 * second Ctrl+C, or a signal after another server in the same process
 * already stopped) return immediately.
 *
 * Order matches the original inline handler: abort runs → unsubscribe
 * events → close clients → unregister from the instance registry (async,
 * awaited inside the wss.close callback) → close HTTP → close WS → on
 * close, once the unregister settles, `onStopped()`.
 */
export function createWebuiShutdown(res: WebuiShutdownResources): () => void {
  const log = res.log ?? ((m: string) => console.log(m));
  const debug = res.debug ?? ((m: string) => console.debug(m));
  const unregister = res.unregisterFn ?? unregisterInstance;
  let started = false;

  return () => {
    if (started) return;
    started = true;
    log('[WebUI] Shutting down...');
    res.abortInFlight();
    res.unsubscribeEvents();
    res.disposeResources?.();
    res.closeClients();
    // Drop ourselves from the running-instance registry; the run promise
    // resolves only after the write settles so callers can safely remove
    // the registry directory once runWebUI's promise resolves.
    const unregistered = unregister(res.pid, res.registryBaseDir).catch((err: unknown) =>
      debug(`[webui-server] unregister failed: ${err}`),
    );
    res.closeHttpServer();
    res.wss.close(() => {
      void unregistered.then(() => {
        log('[WebUI] Server stopped');
        res.onStopped();
      });
    });
  };
}

/**
 * Register `shutdown` on SIGINT and SIGTERM. The wrapper self-detaches
 * both listeners on first fire (so a server that has already shut down
 * can't re-trigger teardown). Returns an unregister function for tests
 * and clean restarts.
 */
export function registerWebuiSignalHandlers(shutdown: () => void): () => void {
  const handler = (): void => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
    shutdown();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
