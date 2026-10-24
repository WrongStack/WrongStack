/**
 * `wstack hq` subcommand group — HQ command center lifecycle + browser
 * token management.
 *
 * Subcommand tree:
 *   wstack hq                      → start HQ server (alias for `wstack --hq`)
 *   wstack hq serve                → start HQ server (explicit form)
 *   wstack hq token create [label] [--ttl <duration>] → mint a browser token, write auth.json
 *   wstack hq token create --client [label] [--ttl <duration>] → mint a client token (/ws/client)
 *   wstack hq token list           → list issued browser tokens
 *   wstack hq token list --client   → list issued client tokens
 *   wstack hq token revoke <id>    → revoke a browser token (prefix match)
 *   wstack hq token revoke --client <id> → revoke a client token
 *   wstack hq service install|status|update|uninstall → Ubuntu systemd lifecycle
 *
 * All subcommands accept `--data-dir <path>` to override the HQ data
 * directory (default `~/.wrongstack/hq`, honors `WRONGSTACK_HOME` /
 * `WRONGSTACK_HQ_DATA_DIR`).
 *
 * @module subcommands/handlers/hq
 */
import {
  HQ_AUTH_FILE_VERSION,
  HQ_CLI_DEFAULT_HOST,
  HqInsecureExposureError,
  isLoopbackHost,
} from '@wrongstack/hq';
import type { HqServerHandle } from '../../hq-server/handle-types.js';
import { parseHqIpAllowlist } from '../../hq-server/ip-allowlist.js';
import { resolveHqPasswordInput } from '../../hq-server/secret-input.js';
import { normalizeHqPublicOrigin } from '../../hq-server/utils.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

// ── --ttl parsing ──────────────────────────────────────────────────────────
//
// Delegates to the shared `parseTokenTtlValue` from utils/hq-ttl.ts so the
// same syntax (1h, 7d, 3600s, bare ms) is accepted here and in the
// server-startup `--hq-token-ttl` flag.

import { parseTokenTtlValue as parseTtlValue } from '../../utils/hq-ttl.js';
import { hqAlertsCmd } from './hq-alerts.js';
import { hqAuditCmd } from './hq-audit.js';
import { resolveDataDir } from './hq-data-dir.js';
import { hqTokenCmd } from './hq-token.js';

export const hqCmd: SubcommandHandler = async (args, deps) => {
  // `--password -x…` parses as `password: true` with the password left in
  // positional, where it would be echoed as an unknown subcommand. Refuse
  // before anything reads or prints the positional.
  if (deps.flags?.['password'] === true) {
    deps.renderer.writeError(
      '--password requires a value. For a password that starts with "-", ' +
        'use --password=<value> or WRONGSTACK_HQ_PASSWORD.\n',
    );
    return 1;
  }
  const sub = args[0];

  // `wstack hq --help` / `wstack hq serve --help` → top-level HQ help.
  // For deep subcommands (`token`, `audit`), fall through to their handlers
  // so each level can print its own focused help. The help short-circuit in
  // short-circuit-flags.ts defers here when a known subcommand positional
  // accompanies --help.
  if (deps.flags?.['help'] === true && (!sub || sub === 'serve')) {
    printHelp(deps);
    return 0;
  }

  // `wstack hq` and `wstack hq serve` start the server.
  if (!sub || sub === 'serve') {
    return startServer(deps);
  }

  if (sub === 'token') {
    return hqTokenCmd(args.slice(1), deps);
  }

  if (sub === 'audit') {
    return hqAuditCmd(args.slice(1), deps);
  }

  if (sub === 'alerts') {
    return hqAlertsCmd(args.slice(1), deps);
  }

  if (sub === 'service') {
    const { hqServiceCmd } = await import('../../hq-service.js');
    return hqServiceCmd(args.slice(1), deps);
  }

  if (sub === 'help' || sub === '--help') {
    printHelp(deps);
    return 0;
  }

  deps.renderer.writeError(`Unknown hq subcommand: ${sub}\n`);
  printHelp(deps);
  return 1;
};

async function startServer(deps: SubcommandDeps): Promise<number> {
  const { startHqServer } = await import('../../hq-server.js');
  const dataDir = resolveDataDir(deps);
  const flags = deps.flags ?? {};
  const rawPublicUrl =
    typeof flags['hq-public-url'] === 'string'
      ? flags['hq-public-url']
      : process.env.WRONGSTACK_HQ_PUBLIC_URL;
  let publicOrigin: string | undefined;
  if (rawPublicUrl !== undefined && rawPublicUrl.trim() !== '') {
    try {
      publicOrigin = normalizeHqPublicOrigin(rawPublicUrl);
    } catch (cause) {
      deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
  }
  const host =
    typeof flags['host'] === 'string'
      ? flags['host']
      : publicOrigin !== undefined
        ? '127.0.0.1'
        : HQ_CLI_DEFAULT_HOST;
  const rawPort = typeof flags['port'] === 'string' ? flags['port'].trim() : undefined;
  const port = rawPort === undefined ? 3499 : /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    deps.renderer.writeError(`Invalid --port value: ${String(flags['port'])}\n`);
    return 1;
  }
  if (publicOrigin !== undefined && !isLoopbackHost(host)) {
    deps.renderer.writeError(
      'Persistent public HQ requires a loopback bind. Remove --host or use --host 127.0.0.1.\n',
    );
    return 1;
  }
  const strictPort = flags['strict-port'] === true;
  const open = flags['open'] === true;
  let password: string | undefined;
  try {
    password = await resolveHqPasswordInput({
      ...(typeof flags['password'] === 'string' ? { explicitPassword: flags['password'] } : {}),
    });
  } catch (cause) {
    deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  const bootstrapPasswordOnly = /^(?:1|true)$/i.test(
    process.env.WRONGSTACK_HQ_BOOTSTRAP_PASSWORD_ONLY?.trim() ?? '',
  );
  const allowInsecureOpen = flags['insecure-open'] === true;
  const rawAllowlist =
    typeof flags['hq-allowlist'] === 'string'
      ? flags['hq-allowlist']
      : process.env.WRONGSTACK_HQ_ALLOWLIST;
  let ipAllowlist: string[] | undefined;
  try {
    ipAllowlist = parseHqIpAllowlist(rawAllowlist);
  } catch (cause) {
    deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  const rawTtl = typeof flags['hq-token-ttl'] === 'string' ? flags['hq-token-ttl'] : undefined;
  let tokenTtlMs: number | undefined;
  if (rawTtl !== undefined && rawTtl.length > 0) {
    const parsed = parseTtlValue(rawTtl);
    if (parsed.error) {
      deps.renderer.writeError(`Invalid --hq-token-ttl: ${parsed.error}\n`);
      return 1;
    }
    tokenTtlMs = parsed.value;
  }

  // WS-106: opt-in `X-Forwarded-For` trust for the login backoff. Absent or 0
  // means "ignore the header", which is the correct default for a direct bind
  // and the only safe one for an unknown topology.
  const rawHops =
    typeof flags['hq-trusted-proxy-hops'] === 'string' ? flags['hq-trusted-proxy-hops'] : undefined;
  let trustedProxyHops: number | undefined;
  if (rawHops !== undefined && rawHops.length > 0) {
    const parsed = Number.parseInt(rawHops, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== rawHops.trim()) {
      deps.renderer.writeError(
        '--hq-trusted-proxy-hops must be a non-negative integer (0 = ignore X-Forwarded-For).\n',
      );
      return 1;
    }
    trustedProxyHops = parsed;
  }

  if (password !== undefined && password.length < 8) {
    deps.renderer.writeError('HQ password must be at least 8 characters.\n');
    return 1;
  }

  let handle: HqServerHandle;
  try {
    handle = await startHqServer({
      host,
      port,
      strictPort,
      dataDir,
      allowInsecureOpen,
      secureCookies: publicOrigin !== undefined,
      requireBrowserAuth: publicOrigin !== undefined,
      ...(password !== undefined ? { password } : {}),
      ...(bootstrapPasswordOnly ? { bootstrapPasswordOnly: true } : {}),
      ...(tokenTtlMs !== undefined ? { tokenTtlMs } : {}),
      ...(trustedProxyHops !== undefined ? { trustedProxyHops } : {}),
      ...(ipAllowlist !== undefined ? { ipAllowlist } : {}),
    });
  } catch (err) {
    // A refusal is operator-actionable guidance, not a crash — print the
    // remedies rather than a stack trace.
    if (err instanceof HqInsecureExposureError) {
      deps.renderer.writeError(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (publicOrigin !== undefined) {
    if (handle.firstRunSetup?.passwordMode !== true) {
      await handle.close();
      deps.renderer.writeError(
        'Persistent public HQ requires password mode. Set WRONGSTACK_HQ_PASSWORD and retry.\n',
      );
      return 1;
    }
    handle.trustPublicOrigin(publicOrigin);
    deps.renderer.write(`Public endpoint:  ${publicOrigin}/\n`);
    deps.renderer.write(`Public mobile:    ${publicOrigin}/mobile\n`);
  }

  if (open) {
    try {
      const { openBrowser } = await import('@wrongstack/webui-server');
      openBrowser(
        publicOrigin ?? handle.firstRunSetup?.browserUrl ?? `http://${handle.host}:${handle.port}`,
      );
    } catch {
      // best-effort
    }
  }

  writeStartupInfo(deps, handle);
  deps.renderer.write(
    ipAllowlist === undefined
      ? 'Network allowlist: disabled (authentication remains required when configured).\n'
      : `Network allowlist: active (${ipAllowlist.length} configured rule${ipAllowlist.length === 1 ? '' : 's'} + loopback).\n`,
  );

  // Keep the process alive until SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      try {
        await handle.close();
      } catch (err) {
        deps.renderer.write(`HQ server close error: ${String(err)}\n`);
      }
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function writeStartupInfo(deps: SubcommandDeps, handle: HqServerHandle): void {
  deps.renderer.write(`WrongStack HQ listening on http://${handle.host}:${handle.port}\n`);
  if (!handle.firstRunSetup) {
    deps.renderer.write(`Client endpoint:  ws://${handle.host}:${handle.port}/ws/client\n`);
    deps.renderer.write(`Browser endpoint: http://${handle.host}:${handle.port}\n`);
    deps.renderer.write(
      `Mobile endpoint:  http://${handle.host}:${handle.port}/mobile (password required)\n`,
    );
    return;
  }

  if (process.env.WRONGSTACK_HQ_SUPPRESS_STARTUP_SECRETS === '1') {
    deps.renderer.write(`Browser endpoint: http://${handle.host}:${handle.port}\n`);
    deps.renderer.write(
      `Mobile endpoint:  http://${handle.host}:${handle.port}/mobile (password required)\n`,
    );
    deps.renderer.write(`Client endpoint:  ws://${handle.host}:${handle.port}/ws/client\n`);
    deps.renderer.write(
      `Startup credentials suppressed; auth state is stored in ${handle.firstRunSetup.dataDir}.\n`,
    );
    return;
  }

  const mobileUrl = new URL(handle.firstRunSetup.browserUrl);
  mobileUrl.pathname = '/mobile';
  mobileUrl.search = '';
  mobileUrl.hash = '';
  deps.renderer.write(`Browser endpoint: ${handle.firstRunSetup.browserUrl}\n`);
  deps.renderer.write(`Mobile endpoint:  ${mobileUrl.toString()} (password required)\n`);
  deps.renderer.write(`Client endpoint:  ${handle.firstRunSetup.clientUrl}\n`);
  deps.renderer.write(
    handle.firstRunSetup.createdAuth
      ? `\nFirst-run HQ auth created in ${handle.firstRunSetup.dataDir}\n`
      : `\nHQ auth loaded from ${handle.firstRunSetup.dataDir}\n`,
  );
  deps.renderer.write(`Start clients with:\n`);
  deps.renderer.write(`  WRONGSTACK_HQ_URL=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_URL}\n`);
  if (handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN) {
    deps.renderer.write(
      `  WRONGSTACK_HQ_TOKEN=${handle.firstRunSetup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`,
    );
  }
}

function printHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq <serve | token | audit | service>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`  wstack hq                      Start the HQ command center server.\n`);
  deps.renderer.write(`  wstack hq serve                Same as above (explicit form).\n`);
  deps.renderer.write(
    `  wstack hq token create [label] [--ttl <dur>] Mint a browser token, enter token mode.\n`,
  );
  deps.renderer.write(
    `  wstack hq token create --client [label] [--ttl <dur>]  Mint a client token (/ws/client).\n`,
  );
  deps.renderer.write(`  wstack hq token list           List issued browser tokens.\n`);
  deps.renderer.write(`  wstack hq token list --client   List issued client tokens.\n`);
  deps.renderer.write(
    `  wstack hq token revoke <id>    Revoke a browser token (id prefix match).\n`,
  );
  deps.renderer.write(`  wstack hq token revoke --client <id>  Revoke a client token.\n`);
  deps.renderer.write(
    `  wstack hq audit verify         Re-derive auth.json contentHash for forensic comparison.\n`,
  );
  deps.renderer.write(
    `  wstack hq service install      Install persistent Ubuntu/systemd service + updater timer.\n`,
  );
  deps.renderer.write(`  wstack hq service status       Show service and updater status.\n`);
  deps.renderer.write(`  wstack hq service update       Run the guarded update job now.\n`);
  deps.renderer.write(
    `  wstack hq service uninstall    Remove units but preserve HQ data and secret file.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Flags (apply to all subcommands):\n`);
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write(
    `  --host <ip>         Bind host (default 0.0.0.0; use 127.0.0.1 for local-only).\n`,
  );
  deps.renderer.write(
    `  --tunnel            Publish a temporary *.trycloudflare.com URL (requires cloudflared).\n`,
  );
  deps.renderer.write(
    `  --hq-public-url <https-origin>  Trust a persistent TLS reverse-proxy origin; binds loopback and requires password mode.\n`,
  );
  deps.renderer.write(`  --password <value>  Set or rotate the browser login password.\n`);
  deps.renderer.write(
    `  --insecure-open     Allow a non-loopback bind with no token/password set.\n`,
  );
  deps.renderer.write(`  --port <n>          Bind port (default 3499).\n`);
  deps.renderer.write(`  --strict-port       Fail if port is in use.\n`);
  deps.renderer.write(
    `  --hq-token-ttl <dur>  Stamp an expiresAt on first-run tokens (e.g. 1h, 7d, 3600s).\n`,
  );
  deps.renderer.write(
    `  --hq-trusted-proxy-hops <n>  Trust the rightmost n X-Forwarded-For entries when rate-limiting logins.\n` +
      `                        Default 0 (ignore the header). Set to the real hop count behind a tunnel,\n` +
      `                        otherwise every user shares one backoff bucket. Never guess high.\n`,
  );
  deps.renderer.write(
    `  --hq-allowlist <csv>  Optional source IP/CIDR allowlist (for example 203.0.113.4,10.0.0.0/8).\n`,
  );
  deps.renderer.write(`  --open              Open the dashboard in the default browser.\n`);
  deps.renderer.write(
    `  --client, -c        Operate on client tokens instead of browser tokens.\n`,
  );
  deps.renderer.write(
    `  --capabilities <csv>  Token grants (browser: control.enqueue,control.approve; client: telemetry.publish,control.execute).\n`,
  );
  deps.renderer.write(
    `  --ttl <duration>    Stamp an expiresAt on the token (e.g. --ttl 1h, --ttl 7d, --ttl 3600s).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`auth.json schema version: ${HQ_AUTH_FILE_VERSION}.\n`);
}
