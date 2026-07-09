// Server entry point for standalone WebUI.
// Bind defaults: 127.0.0.1:3457 (loopback only). Override with --host /
// WEBUI_HOST / WS_HOST and --ws-port / WS_PORT. HTTP frontend defaults to 3456 (override with
// --port / PORT). Run several instances on
// different PORT/WS_PORT pairs — `wstackui --list` shows which are open for which
// project (registry: ~/.wrongstack/webui-instances.json).
import { ToolValidationError } from '@wrongstack/core';
import { startWebUI } from './index.js';
import { formatInstances, listInstances } from './instance-registry.js';

const argv = process.argv.slice(2);

function readArg(names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current) continue;
    for (const name of names) {
      if (current === name) {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) {
          throw new ToolValidationError({ message: `${name} requires a value`, field: name });
        }
        return next;
      }
      if (current.startsWith(`${name}=`)) return current.slice(name.length + 1);
    }
  }
  return undefined;
}

function parsePort(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ToolValidationError({
      message: `${label} must be a port between 1 and 65535`,
      field: 'port',
    });
  }
  return parsed;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function printHelp(): void {
  console.log(`Usage: wstackui [options]

Options:
  --host <host>             Bind host/interface (default: 127.0.0.1)
  --port <port>             HTTP frontend port (default: 3456)
  --ws-port <port>          WebSocket backend port (default: 3457)
  --dist-dir <dir>          Path to the built WebUI frontend assets (default: resolve @wrongstack/webui)
  --token <token>           Fixed access token/password (default: random per process)
  --public-url <url>        Browser-facing HTTP URL for tunnels/proxies
  --public-ws-url <url>     Browser-facing ws:// or wss:// URL for tunnels/proxies
  --require-token           Require token/password even on loopback binds
  --open, -o                Open the browser after startup
  --list, -l, ls            List running WebUI instances
  --help, -h                Show this help
`);
}

// `wstackui --list` / `wstackui ls` — print running instances and exit. Cheap,
// side-effect-free (it only prunes dead pids), so it never boots a server.
if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
} else if (argv.includes('--list') || argv.includes('-l') || argv[0] === 'ls') {
  listInstances()
    .then((instances) => {
      console.log(formatInstances(instances));
      process.exit(0);
    })
    .catch((err) => {
      console.error(JSON.stringify({
        level: 'fatal',
        event: 'webui.instance_registry_read_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
      process.exit(1);
    });
} else {
  let wsPort: number;
  let httpPort: number;
  let wsHost: string;
  let accessToken: string | undefined;
  let publicUrl: string | undefined;
  let publicWsUrl: string | undefined;
  let distDir: string | undefined;
  try {
    wsHost =
      readArg(['--host']) ??
      process.env['WEBUI_HOST'] ??
      process.env['WS_HOST'] ??
      '127.0.0.1';
    httpPort = parsePort(
      readArg(['--port', '--http-port']) ?? process.env['WEBUI_PORT'] ?? process.env['PORT'],
      3456,
      '--port',
    );
    wsPort = parsePort(readArg(['--ws-port']) ?? process.env['WS_PORT'], 3457, '--ws-port');
    accessToken =
      readArg(['--token', '--auth-token']) ??
      process.env['WEBUI_TOKEN'] ??
      process.env['WEBUI_AUTH_TOKEN'];
    publicUrl = readArg(['--public-url']) ?? process.env['WEBUI_PUBLIC_URL'];
    publicWsUrl = readArg(['--public-ws-url']) ?? process.env['WEBUI_PUBLIC_WS_URL'];
    distDir = readArg(['--dist-dir']) ?? process.env['WEBUI_DIST_DIR'];
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const open =
    argv.includes('--open') || argv.includes('-o') || process.env['WEBUI_OPEN'] === '1';
  const requireToken = argv.includes('--require-token') || envFlag('WEBUI_REQUIRE_TOKEN');

  console.log(`[WebUI] Starting standalone server on ${wsHost} (http:${httpPort}, ws:${wsPort})...`);

  startWebUI({
    wsPort,
    wsHost,
    httpPort,
    accessToken,
    publicUrl,
    publicWsUrl,
    requireToken,
    open,
    distDir,
  }).catch((err) => {
    console.error(JSON.stringify({
      level: 'fatal',
      event: 'webui.startup_failed',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  });
}
