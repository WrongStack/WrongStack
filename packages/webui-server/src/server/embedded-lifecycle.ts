import * as path from 'node:path';
import {
  registerInstance,
  unregisterInstance,
  type WebUIInstanceRecord,
  type WebUIInstanceRole,
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
  /** Runtime role. Missing means the legacy standalone WebUI/SimpleUI role. */
  role?: WebUIInstanceRole | undefined;
  /** Live session owned by this endpoint when `role === 'session-child'`. */
  sessionId?: string | undefined;
  /** Parent shell process identity, when this endpoint was spawned by a parent. */
  parentPid?: number | undefined;
  parentShellId?: string | undefined;
  /** Stable child runtime id, distinct from the session id. */
  runtimeId?: string | undefined;
  /** Whether a parent shell should treat this endpoint as attachable. */
  attachable?: boolean | undefined;
  /** Health/protocol hints for future parent shells. */
  lastReadyAt?: string | undefined;
  protocolVersion?: number | undefined;
  capabilities?: string[] | undefined;
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
export async function registerWebuiInstance(
  p: RegisterWebuiInstanceParams,
  deps: RegisterWebuiInstanceDeps = {},
): Promise<boolean> {
  const register = deps.registerFn ?? registerInstance;
  try {
    await register(
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
        ...(p.role ? { role: p.role } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.parentPid !== undefined ? { parentPid: p.parentPid } : {}),
        ...(p.parentShellId ? { parentShellId: p.parentShellId } : {}),
        ...(p.runtimeId ? { runtimeId: p.runtimeId } : {}),
        ...(p.attachable !== undefined ? { attachable: p.attachable } : {}),
        ...(p.authToken ? { auth: { scheme: 'registry-token' as const, tokenPresent: true } } : {}),
        ...(p.lastReadyAt ? { lastReadyAt: p.lastReadyAt } : {}),
        ...(p.protocolVersion !== undefined ? { protocolVersion: p.protocolVersion } : {}),
        ...(p.capabilities ? { capabilities: p.capabilities } : {}),
      },
      p.registryBaseDir,
    );
    return true;
  } catch {
    return false;
  }
}

// ── Ready banner + open browser ──────────────────────────────────────

export interface AnnounceWebuiReadyParams {
  /** Surface kind — 'webui' or 'simpleui'. */
  surface: SurfaceKind;
  /** The HTTP server (StaticServeHandle.server). */
  server: { on: (event: 'listening', cb: () => void) => void; listening?: boolean };
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
  // The browser-launch URL carries the one-time bootstrap token so the
  // frontend can exchange it for an HttpOnly cookie. The separately rendered
  // display URL must stay token-free because banners are captured in logs.
  const displayUrl = buildWebUIAccessUrl({
    host: p.host,
    port: p.httpPort,
    publicUrl: p.publicUrl,
  });
  const openUrl = buildWebUIAccessUrl({
    host: p.host,
    port: p.httpPort,
    token: p.wsToken,
    publicUrl: p.publicUrl,
  });
  const announce = (): void => {
    const extraUrls = formatExternalAccessUrls({
      bindHost: p.host,
      port: p.httpPort,
      publicUrl: p.publicUrl,
    });
    const extraBlock =
      extraUrls.length > 0
        ? `\n  Protected endpoints on external interfaces:\n${extraUrls.join('\n')}\n`
        : '';
    const authHint = p.wsToken
      ? ' (authentication required; use automatic browser launch or a separately provisioned WEBUI_TOKEN)'
      : '';
    log(
      `\n  ▸ ${p.surface === 'webui' ? 'WebUI' : 'SimpleUI'} ready at \x1b[1m${displayUrl}\x1b[0m${authHint}` +
        `    (same agent as this terminal)\n${extraBlock}`,
    );
    if (p.open) launch(openUrl);
  };
  // Hosts that await the bind before announcing (listenWithRetry /
  // startDeferredHttpListen) reach here with 'listening' already fired —
  // subscribing then would never run the banner or launch the browser.
  if (p.server.listening) {
    announce();
    return;
  }
  p.server.on('listening', announce);
}

// ── Graceful shutdown (SIGINT/SIGTERM) ───────────────────────────────

export interface WebuiShutdownResources {
  /** Abort every in-flight run (legacy single slot + per-socket controllers) and clear them. */
  abortInFlight: () => void;
  /** Run and drop every event-bus unsubscriber. */
  unsubscribeEvents: () => void;
  /** Dispose long-lived handlers, timers, watchers, and project services owned by the host. */
  disposeResources?: (() => void | Promise<void>) | undefined;
  /**
   * Stop session-owned child processes (MCP, bash/exec tools, mailbox helpers,
   * dev servers). Runs **before** the HTTP/WS close so children cannot keep
   * stdio handles open and strand the parent event loop (issue #322).
   * Bounded by {@link childCleanupTimeoutMs}; failures are best-effort.
   */
  stopOwnedChildren?: (() => void | Promise<void>) | undefined;
  /**
   * Upper bound for {@link stopOwnedChildren} + async dispose before servers
   * close. Default 10_000 ms.
   */
  childCleanupTimeoutMs?: number | undefined;
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

const DEFAULT_CHILD_CLEANUP_TIMEOUT_MS = 10_000;

async function runBounded(
  work: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
  debug: (msg: string) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => work())
        .catch((err: unknown) => {
          debug(`[webui-server] ${label} failed: ${err}`);
        }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          debug(`[webui-server] ${label} timed out after ${timeoutMs}ms`);
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the SIGINT/SIGTERM teardown handler. The returned function is
 * idempotent: the first call runs the teardown, later calls (e.g. a
 * second Ctrl+C, or a signal after another server in the same process
 * already stopped) return immediately.
 *
 * Order (issue #322): abort runs → unsubscribe events → stop owned children
 * (bounded) → dispose resources (bounded) → close clients → close HTTP/WS →
 * unregister from the instance registry → onStopped once unregister settles.
 * Registry removal is deferred until after child cleanup so operators do not
 * see a "stopped" registry entry while the process tree is still alive.
 */
export function createWebuiShutdown(res: WebuiShutdownResources): () => void {
  const log = res.log ?? ((m: string) => console.log(m));
  const debug = res.debug ?? ((m: string) => console.debug(m));
  const unregister = res.unregisterFn ?? unregisterInstance;
  const childTimeout = Math.max(1, res.childCleanupTimeoutMs ?? DEFAULT_CHILD_CLEANUP_TIMEOUT_MS);
  let started = false;

  return () => {
    if (started) return;
    started = true;
    log('[WebUI] Shutting down...');
    res.abortInFlight();
    res.unsubscribeEvents();

    void (async () => {
      if (res.stopOwnedChildren) {
        await runBounded(res.stopOwnedChildren, childTimeout, 'stopOwnedChildren', debug);
      }
      if (res.disposeResources) {
        // Dispose is usually fast; still bound so a stuck dispose cannot block exit.
        await runBounded(
          res.disposeResources,
          Math.min(childTimeout, 5_000),
          'disposeResources',
          debug,
        );
      }
      res.closeClients();
      res.closeHttpServer();
      // Unregister after children are stopped so the running-instance registry
      // does not report this host as gone while descendants still hold ports.
      const unregistered = unregister(res.pid, res.registryBaseDir).catch((err: unknown) =>
        debug(`[webui-server] unregister failed: ${err}`),
      );
      await new Promise<void>((resolve) => {
        res.wss.close(() => resolve());
      });
      await unregistered;
      log('[WebUI] Server stopped');
      res.onStopped();
    })().catch((err: unknown) => {
      debug(`[webui-server] shutdown sequence failed: ${err}`);
      try {
        res.onStopped();
      } catch {
        /* best-effort */
      }
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
