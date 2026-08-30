/**
 * Port constants for the WebUI / SimpleUI servers.
 *
 * Design:
 * - **Single port — shared HTTP + WebSocket.** The WebSocket server attaches
 *   to the HTTP server (`new WebSocketServer({ server: httpServer })`), so
 *   both protocols share one port. No separate WS port is needed.
 * - **Auto-advance.** When a port is taken the server probes upward — WebUI
 *   starts at 3456, SimpleUI at 3466. Set `WEBUI_STRICT_PORT=1` to disable.
 * - **TOCTOU window.** The probe in `findFreePort` binds a throwaway
 *   `net.Server` then closes it, so there is a tiny race between "found free"
 *   and "real server binds". When that race is lost the real bind fails with
 *   EADDRINUSE; `listenWithRetry` is the safety net — it advances past the
 *   competitor (bounded) instead of crashing or hanging.
 * - **Instance registry.** Every live process records itself in
 *   `~/.wrongstack/webui-instances.json` with its PID, surface, port, and
 *   project root. A crashed instance is pruned on the next registry read
 *   (`process.kill(pid, 0)` probe), so ghosts don't accumulate.
 */

import * as net from 'node:net';
import { ToolValidationError } from '@wrongstack/core/types';

/**
 * Surface-specific default single port.
 *
 * WebSocket shares the HTTP port (single-port design), so only one port
 * number is specified per surface:
 *
 *   WebUI:   3456
 *   SimpleUI: 3466
 */
export const SURFACE_DEFAULT_PORTS = {
  webui:   { http: 3456 },
  simpleui: { http: 3466 },
} as const satisfies Record<string, { http: number }>;

export type SurfaceKind = keyof typeof SURFACE_DEFAULT_PORTS;

/** Highest valid TCP port number. Single ceiling for every boundary check. */
const MAX_TCP_PORT = 65535;

/** Human-readable label for surfaces. */
export function surfaceLabel(surface: SurfaceKind): string {
  return surface === 'webui' ? 'WebUI' : 'SimpleUI';
}

/**
 * True when `WEBUI_STRICT_PORT` requests fail-fast port binding (no
 * auto-advance). Single source of truth for both `resolvePorts` (probe-time)
 * and `startWebUI`'s bind-time retry — the two must not drift apart.
 */
export function isStrictPort(): boolean {
  const value = process.env['WEBUI_STRICT_PORT'];
  return value === '1' || value === 'true';
}

/**
 * Return the surface-specific default HTTP port.
 */
export function getSurfaceDefaultPorts(surface: SurfaceKind): {
  http: number;
} {
  return { http: SURFACE_DEFAULT_PORTS[surface].http };
}

/** Resolve true when `port` can be bound on `host`, false on EADDRINUSE/EACCES. */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return probePort(host, port).then((err) => err === null);
}

/**
 * Throwaway-listener probe that preserves the errno. Resolves null when
 * `port` is bindable on `host`; otherwise resolves the bind error with its
 * real `code` (EADDRINUSE, EACCES, EADDRNOTAVAIL, RangeError, …) so
 * callers can distinguish retryable contention from fail-fast errors.
 */
function probePort(host: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve(err));
    srv.once('listening', () => {
      srv.close(() => resolve(null));
    });
    try {
      srv.listen(port, host);
    } catch (err) {
      resolve(err as NodeJS.ErrnoException);
    }
  });
}

interface FindFreePortOptions {
  /** Ports to skip even if free (e.g. one already chosen for the sibling server). */
  exclude?: Set<number> | undefined;
  /** How many consecutive ports to try before giving up. Default 200. */
  maxTries?: number | undefined;
}

/**
 * Find the first free port at or above `startPort` on `host`, skipping any in
 * `exclude`. Throws if nothing is free within `maxTries` steps.
 */
export async function findFreePort(
  host: string,
  startPort: number,
  opts: FindFreePortOptions = {},
): Promise<number> {
  const exclude = opts.exclude ?? new Set<number>();
  const maxTries = opts.maxTries ?? 200;
  let port = startPort;
  for (let i = 0; i < maxTries; i++) {
    // Stay inside the valid TCP range; wrap into the high ephemeral band if a
    // pathological startPort pushes us past the ceiling.
    if (port > MAX_TCP_PORT) port = 1024 + (port % 50000);
    if (!exclude.has(port) && (await isPortFree(host, port))) {
      return port;
    }
    port++;
  }
  throw new ToolValidationError({
    message: `No free port found near ${startPort} on ${host} after ${maxTries} attempts.`,
    field: 'port',
  });
}

interface ListenWithRetryOptions {
  /** Bind attempts before giving up on EADDRINUSE. Default 10. */
  maxTries?: number | undefined;
  /**
   * Same-port re-binds attempted before advancing, when the pre-bind probe
   * said the port was free and the real bind still reported EADDRINUSE.
   * Default 2 (see the phantom-EADDRINUSE note in `listenWithRetry`).
   */
  phantomRetries?: number | undefined;
  /** Delay between those same-port re-binds, ms. Default 30. */
  phantomRetryDelayMs?: number | undefined;
}

/**
 * Listen `server` on `host` starting at `port`, advancing one port on each
 * EADDRINUSE — the bind-time safety net for the `findFreePort` TOCTOU window
 * (probe closes, competitor binds, real listen loses the race). Any other
 * error (EACCES, EAFNOSUPPORT, …) rejects immediately; EADDRINUSE past the
 * final attempt rejects with the last error. Resolves with the port the
 * server actually bound, which exceeds the request when a retry advanced.
 *
 * Two hazards this must survive, both observed under Bun on Windows:
 * - a co-listener that throws from the server's 'error' emit (see the
 *   prependOnceListener note below) — settlement must not depend on it;
 * - a phantom EADDRINUSE on a port the pre-bind probe just released.
 */
export function listenWithRetry(
  server: net.Server,
  host: string,
  port: number,
  opts: ListenWithRetryOptions = {},
): Promise<number> {
  const maxTries = opts.maxTries ?? 10;
  const phantomRetries = opts.phantomRetries ?? 2;
  const phantomRetryDelayMs = opts.phantomRetryDelayMs ?? 30;
  return new Promise<number>((resolve, reject) => {
    // Windows can deliver EADDRINUSE as a synchronous throw from a deferred
    // listen() tick (node:net setupListenHandle ← processTicksAndRejections)
    // that escapes BOTH a try/catch around listen() and the 'error' emitter
    // — observed with a long-held holder on 127.0.0.1. Never hand the real
    // server an occupied port: probe first with the same throwaway-listener
    // technique findFreePort uses, and advance only on a genuine EADDRINUSE;
    // any other errno rejects with the real error. The event handlers below
    // remain as the backstop for the (far narrower) probe→bind race.
    // Unifying rule: candidates at or above MAX_TCP_PORT never advance
    // (there is no next port), so a failed bind there rejects with the real
    // error — whether detected by the probe or the backstop handlers.
    const canAdvance = (candidate: number): boolean => candidate < MAX_TCP_PORT;
    const probeable = (candidate: number): boolean =>
      Number.isInteger(candidate) && candidate >= 0 && candidate <= MAX_TCP_PORT;
    let settled = false;
    const settleResolve = (value: number): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const attempt = (candidate: number, remaining: number, phantomLeft: number): void => {
      void (async () => {
        let probedFree = false;
        if (probeable(candidate)) {
          const probeErr = await probePort(host, candidate);
          if (probeErr !== null) {
            // Advance only on genuine contention; every other errno
            // (EACCES, EADDRNOTAVAIL, …) rejects fail-fast with the
            // real error — advancing would be silent misdiagnosis.
            if (probeErr.code === 'EADDRINUSE' && remaining > 1 && canAdvance(candidate)) {
              attempt(candidate + 1, remaining - 1, phantomRetries);
              return;
            }
            settleReject(probeErr);
            return;
          }
          probedFree = true;
        }
        const onError = (err: NodeJS.ErrnoException): void => {
          server.off('listening', onListening);
          server.off('error', onError);
          if (err.code === 'EADDRINUSE') {
            // Phantom EADDRINUSE: our own probe held this port microseconds
            // ago and released it, and the runtime has not finished handing
            // it back. Bun on Windows resolves `net.Server#close(cb)` before
            // the OS releases the listening socket, so the very next bind of
            // that port fails on a port nothing else is using (verified with
            // netstat: no listener at all). Advancing would silently move
            // SimpleUI off its documented default port for a hazard that
            // clears in a few ms, so re-bind the SAME port first (bounded),
            // and only then fall through to advancing.
            if (probedFree && phantomLeft > 0) {
              const timer = setTimeout(() => {
                attempt(candidate, remaining, phantomLeft - 1);
              }, phantomRetryDelayMs);
              timer.unref?.();
              return;
            }
            if (remaining > 1 && canAdvance(candidate)) {
              attempt(candidate + 1, remaining - 1, phantomRetries);
              return;
            }
          }
          settleReject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          settleResolve(address && typeof address === 'object' ? address.port : candidate);
        };
        // prepend, not append: `ws` attaches its own 'error' forwarder to the
        // HTTP server when a WebSocketServer is constructed with {server}, and
        // that forwarder re-emits on a WebSocketServer that has no 'error'
        // listener yet during the bind window — an EventEmitter throw that
        // aborts the emit loop. Appended handlers never run, this promise
        // never settles, and the host hangs forever awaiting a bind that
        // already failed. Running first makes settlement independent of every
        // other listener on the server.
        server.prependOnceListener('error', onError);
        server.prependOnceListener('listening', onListening);
        try {
          server.listen(candidate, host);
        } catch (err) {
          // Sync throws (e.g. RangeError for out-of-range ports) still route
          // through the same error path so non-EADDRINUSE rejects cleanly.
          onError(err as NodeJS.ErrnoException);
        }
      })();
    };
    attempt(port, maxTries, phantomRetries);
  });
}
