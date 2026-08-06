/**
 * --hq short-circuit — extracted from cli-main.ts.
 *
 * Starts the HQ command center server before boot() — HQ is
 * project-independent. Blocks until SIGINT/SIGTERM.
 *
 * Returns 0 when the HQ flag was present and the server ran, or null
 * when the flag was absent (caller should proceed to boot()).
 */

import * as net from 'node:net';
import {
  HQ_CLI_DEFAULT_HOST,
  isLoopbackHost,
  readHqRuntimeFileSync,
  resolveHqDataDir,
} from '@wrongstack/core/hq';
import { color, isPidAlive } from '@wrongstack/core/utils';
import { DEFAULT_PORT } from '../hq-server.js';
import type { HqQuickTunnelHandle } from '../hq-tunnel.js';

interface HqRuntimeMarker {
  url?: string;
  pid?: number;
  updatedAt?: string;
}

/**
 * Returns true if there is an HQ server already running for this data dir
 * (runtime.json exists and its PID is still alive).
 */
async function isHqAlreadyRunning(dataDir: string): Promise<HqRuntimeMarker | null> {
  // Reads through core's parser rather than opening `runtime.json` here.
  //
  // The two used to disagree about the same file. Core required a non-empty
  // `url` and rejected a DEAD pid but accepted a marker with NO pid; this
  // function ignored `url` and rejected a marker with no pid. So for a marker
  // carrying a url and no pid, core said "an HQ is running, attach to it"
  // while boot said "nothing is running, start one" — from the same bytes.
  //
  // Core's reader is the single parse. The extra `pid && isPidAlive` here is
  // this caller's stricter question: "may I skip starting a server?" needs
  // PROOF of life, and a marker without a pid cannot supply it. That
  // distinction is now visible instead of accidental.
  const marker = readHqRuntimeFileSync(dataDir);
  if (!marker) return null;
  // `isPidAlive` treats EPERM as alive: an HQ owned by another user must not
  // read as dead, or we start a second one on top of it.
  if (marker.pid && isPidAlive(marker.pid)) return marker;
  return null;
}

/**
 * Returns true if the port is already in use on the given host.
 */
async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}

/**
 * Check for --hq flag and start the HQ server if present.
 *
 * Returns 0 when the server started, or null when --hq was not set.
 */
export async function handleHqShortCircuit(
  flags: Record<string, string | boolean>,
): Promise<number | null> {
  if (flags['hq'] !== true) return null;

  const { startHqServer } = await import('../hq-server.js');
  const tunnelRequested = flags['tunnel'] === true;
  // The CLI opts into the wide bind explicitly; the library default stays loopback.
  // Quick Tunnel is outbound-only, so keep its origin private by default.
  const host =
    typeof flags['host'] === 'string'
      ? flags['host']
      : tunnelRequested
        ? '127.0.0.1'
        : HQ_CLI_DEFAULT_HOST;
  if (tunnelRequested && !isLoopbackHost(host)) {
    process.stderr.write(
      `${color.red('✗')} --tunnel requires a loopback origin. Remove --host or use --host 127.0.0.1.\n`,
    );
    return 1;
  }

  // Port: use --port flag if explicitly given; otherwise use the documented
  // default without prompting so `wstack --hq` and `wstack hq` are direct
  // launch commands.
  let port: number;
  if (typeof flags['port'] === 'string' && flags['port'].trim() !== '') {
    const parsed = Number.parseInt(flags['port'], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      process.stderr.write(`${color.red('✗')} Invalid --port value: ${flags['port']}\n`);
      return 1;
    }
  } else port = DEFAULT_PORT;

  const dataDir = typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined;
  const password =
    typeof flags['password'] === 'string' ? flags['password'] : process.env.WRONGSTACK_HQ_PASSWORD;
  if (password !== undefined && password.length < 8) {
    process.stderr.write(`${color.red('✗')} HQ password must be at least 8 characters.\n`);
    return 1;
  }
  // User explicitly chose a port if they either passed --port OR accepted
  // a non-default value from the interactive prompt.
  const userProvidedPort =
    (typeof flags['port'] === 'string' && flags['port'].trim() !== '') || port !== DEFAULT_PORT;

  // Resolve data dir the same way startHqServer does so we can check for a
  // running HQ instance before attempting to start a new one.
  const resolvedDataDir = dataDir ?? resolveHqDataDir();
  const existing = await isHqAlreadyRunning(resolvedDataDir);
  if (existing) {
    process.stderr.write(
      `${color.red('✗')} HQ is already running at ${existing.url} ` +
        `(PID ${existing.pid}). Stop it first or use a different --data-dir.\n`,
    );
    return 1;
  }

  // Probe the port before binding — fail fast with a clear message.
  if (await isPortInUse(host, port)) {
    process.stderr.write(
      `${color.red('✗')} Port ${port} is already in use. ` +
        `Choose a different port or stop the process using it.\n`,
    );
    return 1;
  }

  // --hq-token-ttl: optional TTL stamped on first-run tokens (e.g. "1h", "7d", "86400000").
  let tokenTtlMs: number | undefined;
  const rawTtl =
    typeof flags['hq-token-ttl'] === 'string'
      ? flags['hq-token-ttl']
      : (process.env.WRONGSTACK_HQ_TOKEN_TTL as string | undefined);
  if (rawTtl !== undefined && rawTtl.length > 0) {
    const { parseTokenTtlValue } = await import('../utils/hq-ttl.js');
    const parsed = parseTokenTtlValue(rawTtl);
    if (parsed.error) {
      process.stderr.write(`${color.red('✗')} Invalid --hq-token-ttl: ${parsed.error}\n`);
      return 1;
    }
    tokenTtlMs = parsed.value;
  }

  let handle;
  try {
    handle = await startHqServer({
      host,
      port,
      strictPort: flags['strict-port'] === true,
      exactPort: userProvidedPort,
      allowInsecureOpen: flags['insecure-open'] === true,
      secureCookies: tunnelRequested,
      requireBrowserAuth: tunnelRequested,
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(tokenTtlMs !== undefined ? { tokenTtlMs } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `${color.red('✗')} Port ${port} is already in use. Please choose a different port.\n`,
      );
    } else {
      process.stderr.write(`${color.red('✗')} Failed to start HQ server: ${msg}\n`);
    }
    return 1;
  }

  let tunnel: HqQuickTunnelHandle | undefined;
  let browserUrl = handle.firstRunSetup?.browserUrl ?? `http://${handle.host}:${handle.port}`;
  if (tunnelRequested) {
    if (
      handle.firstRunSetup !== undefined &&
      !handle.firstRunSetup.browserTokenMode &&
      !handle.firstRunSetup.passwordMode
    ) {
      await handle.close();
      process.stderr.write(
        `${color.red('✗')} Refusing to publish HQ in open mode. Set --password or create a browser token first.\n`,
      );
      return 1;
    }
    try {
      const { buildPublicHqUrl, startHqQuickTunnel } = await import('../hq-tunnel.js');
      const originHost = handle.host === '::1' ? '[::1]' : handle.host;
      tunnel = await startHqQuickTunnel(`http://${originHost}:${handle.port}`, {
        onUnexpectedExit: (message) => process.stderr.write(`${color.yellow('!')} ${message}\n`),
      });
      // cloudflared discovered this URL from its own process output, so it is a
      // server-established origin rather than a client-selected Host header.
      handle.trustPublicOrigin(new URL(tunnel.url).origin);
      browserUrl = buildPublicHqUrl(
        tunnel.url,
        handle.firstRunSetup?.browserUrl,
        handle.firstRunSetup?.passwordMode !== true,
      );
      process.stdout.write(`\n${color.green('Cloudflare Quick Tunnel ready:')} ${browserUrl}\n`);
      process.stdout.write(
        `${color.dim('Temporary development URL; DNS may need a few seconds, it changes on restart and ends when HQ stops.')}\n`,
      );
    } catch (err) {
      await handle.close();
      process.stderr.write(
        `${color.red('✗')} Failed to start Cloudflare Quick Tunnel: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  if (flags['open'] === true) {
    try {
      const { openBrowser } = await import('@wrongstack/webui-server');
      openBrowser(browserUrl);
    } catch {
      // best-effort
    }
  }
  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      const results = await Promise.allSettled([
        ...(tunnel ? [tunnel.close()] : []),
        handle.close(),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'hq.server_close_failed',
            message: String(failure.reason),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}
