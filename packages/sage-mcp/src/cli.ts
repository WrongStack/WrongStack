#!/usr/bin/env node
/**
 * `wstack-sage-mcp` — Standalone MCP server for WrongStack SAGE Memory.
 *
 * Two operating modes (default stdio; --http for loopback HTTP):
 *
 *   $ wstack-sage-mcp --project-root <path>
 *     # talks JSON-RPC over stdio
 *
 *   $ wstack-sage-mcp --project-root <path> --http --port 8765
 *     # loopback HTTP; refuses non-loopback without --token
 *
 * The memory port is acquired by connecting to the existing SAGE IPC
 * project server (Unix socket / Windows named pipe). If no server is
 * running, the connection logic in `SageProjectServerConnection`
 * (`packages/sage/src/project-server-client.ts:233-275`) lazily spawns
 * `project-server.js` from `@wrongstack/sage` — the same single-owner
 * SQLite process that any wstack CLI / TUI / WebUI would attach to.
 *
 * Default tool policy: read-only (`permission === 'auto'`,
 * `riskTier === 'safe'`). Pass `--writable` to expose standard-tier
 * Sage tools (writes, deletes, hygiene).
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import { isSageProjectServerAvailable, ProjectSageMemoryPort } from '@wrongstack/sage';
import { createSageMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

interface ParsedArgs {
  projectRoot: string;
  storageDirectory?: string | undefined;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  /** `--token` given with no value: refused instead of serving without auth. */
  tokenMissing?: boolean | undefined;
  writable: boolean;
  help: boolean;
}

function printHelp(stdout: NodeJS.WriteStream): void {
  stdout.write(
    [
      `${SERVER_INFO.name} v${SERVER_INFO.version} — SAGE Memory MCP server`,
      '',
      'Usage:',
      `  ${SERVER_INFO.name} --project-root <path> [options]`,
      '',
      'Options:',
      '  --project-root <path>   Project root whose SAGE memory should be served (required).',
      '  --storage-dir <path>    Override the SAGE storage directory.',
      '  --stdio                 Use stdio transport (default).',
      '  --http                  Use HTTP transport.',
      '  --port <n>              TCP port for HTTP mode (default 0 = ephemeral).',
      '  --host <h>              Bind host for HTTP mode (default 127.0.0.1;',
      '                          non-loopback REQUIRES --token, refused by serveHttp).',
      '  --token <t>             Bearer token for HTTP mode.',
      '                          Prefer WRONGSTACK_MCP_TOKEN — a command line is readable',
      '                          by other local processes (WS-064).',
      '  --writable              Expose standard-tier (write/delete) tools.',
      '  -h, --help              Show this message.',
      '',
      'Existing SAGE IPC server connection:',
      `  isSageProjectServerAvailable() = ${String(isSageProjectServerAvailable())}`,
    ].join('\n') + '\n',
  );
}

/**
 * Environment variable carrying the HTTP auth token (WS-064).
 *
 * `--token <value>` was the ONLY way to supply it, which puts the secret in
 * places any local process can read: `/proc/<pid>/cmdline` is world-readable on
 * Linux, `Win32_Process.CommandLine` is readable by any process on Windows, and
 * the value lands in shell history either way. An environment variable is not
 * secret-storage, but `/proc/<pid>/environ` is restricted to the owning user,
 * so it is strictly better than the command line.
 *
 * The flag still wins when both are given — an explicit argument overriding the
 * ambient environment is the behaviour a caller expects, and silently
 * preferring the env var could route a token the operator did not intend. Using
 * it just warns.
 */
const HTTP_TOKEN_ENV = 'WRONGSTACK_MCP_TOKEN';

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgs {
  const out: ParsedArgs = {
    projectRoot: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    help: false,
  };
  const warn = (event: string, message: string): void => {
    console.warn(
      JSON.stringify({ level: 'warn', event, message, timestamp: new Date().toISOString() }),
    );
  };
  const KNOWN_FLAGS = new Set([
    '--project-root',
    '--storage-dir',
    '--stdio',
    '--http',
    '--port',
    '--host',
    '--token',
    '--writable',
    '-h',
    '--help',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const rawArg = argv[i] ?? '';
    const eqIndex = rawArg.startsWith('--') ? rawArg.indexOf('=') : -1;
    const arg = eqIndex > 0 ? rawArg.slice(0, eqIndex) : rawArg;
    const inlineValue = eqIndex > 0 ? rawArg.slice(eqIndex + 1) : undefined;
    // A secret may begin with "-" (base64url); refusing it dropped the token
    // and echoed it to stderr as an unknown option.
    const value = (allowDash = false): string | undefined => {
      if (inlineValue !== undefined) {
        const trimmedInline = inlineValue.trim();
        if (!trimmedInline) {
          warn('mcp_cli_flag_empty_value', `${arg} expects a non-empty value; ignoring it.`);
          return undefined;
        }
        return trimmedInline;
      }
      const next = argv[i + 1];
      const nextFlag = next?.startsWith('--') ? (next.split('=', 1)[0] ?? next) : next;
      if (
        next === undefined ||
        (nextFlag !== undefined && KNOWN_FLAGS.has(nextFlag)) ||
        (!allowDash && next.startsWith('-'))
      ) {
        warn('mcp_cli_flag_missing_value', `${arg} expects a value; ignoring it.`);
        return undefined;
      }
      i++;
      const trimmed = next.trim();
      if (!trimmed) {
        warn('mcp_cli_flag_empty_value', `${arg} expects a non-empty value; ignoring it.`);
        return undefined;
      }
      return trimmed;
    };
    // A switch takes no value, but `--writable=false` used to GRANT the tier it
    // was written to deny. `true`/`1` keep the switch; any other value leaves it off.
    const switchOn = (): boolean => {
      if (inlineValue === undefined) return true;
      const flag = inlineValue.trim().toLowerCase();
      if (flag === 'true' || flag === '1') return true;
      if (flag !== 'false' && flag !== '0') {
        warn('mcp_cli_flag_invalid_switch', `${arg} takes no value; ignoring it.`);
      }
      return false;
    };
    switch (arg) {
      case '--project-root': {
        const next = value();
        if (next !== undefined) out.projectRoot = path.resolve(next);
        break;
      }
      case '--storage-dir': {
        const next = value();
        if (next !== undefined) out.storageDirectory = path.resolve(next);
        break;
      }
      case '--stdio':
        out.transport = 'stdio';
        break;
      case '--http':
        out.transport = 'http';
        break;
      case '--port': {
        const next = value();
        if (next === undefined) break;
        const port = Number(next);
        if (Number.isInteger(port) && port >= 0 && port <= 65_535) out.httpPort = port;
        else warn('mcp_cli_invalid_port', `--port ${next} is not a valid port; using 0.`);
        break;
      }
      case '--host': {
        const next = value();
        if (next !== undefined) out.httpHost = next;
        break;
      }
      case '--token': {
        const next = value(true);
        if (next !== undefined) {
          out.httpToken = next;
          out.tokenMissing = false;
        } else if (out.httpToken === undefined) {
          out.tokenMissing = true;
        }
        break;
      }
      case '--writable':
        if (switchOn()) out.writable = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (arg?.startsWith('-')) warn('mcp_cli_unknown_option', `unknown option ${arg} ignored.`);
        break;
    }
  }
  // WS-064: fall back to the environment, and warn when the token came from
  // the command line where other local processes can read it.
  if (out.httpToken === undefined) {
    const fromEnv = env[HTTP_TOKEN_ENV]?.trim();
    if (fromEnv) {
      out.httpToken = fromEnv;
      out.tokenMissing = false;
    }
  } else if (out.httpToken.length > 0) {
    console.warn(
      `[mcp] --token puts the auth token in this process's command line, which other ` +
        `local processes can read. Prefer ${HTTP_TOKEN_ENV}.`,
    );
  }
  return out;
}

/** Convert the parsed absolute override back to SAGE's project-relative path contract. */
export function projectRelativeStorageDirectory(projectRoot: string, directory: string): string {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const resolvedDir = path.resolve(directory);
  let canonicalDir = resolvedDir;
  try {
    canonicalDir = realpathSync(resolvedDir);
  } catch {
    try {
      canonicalDir = path.join(realpathSync(path.dirname(resolvedDir)), path.basename(resolvedDir));
    } catch {
      canonicalDir = resolvedDir;
    }
  }
  const relative = path.relative(canonicalRoot, canonicalDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--storage-dir must stay inside the project root');
  }
  return relative || '.';
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  // A trailing `--token` with no value used to be ignored, binding HTTP with
  // no auth at all although the operator asked for one (as 50b70bd64 refuses
  // for `wstack mcp serve`).
  if (args.tokenMissing) {
    process.stderr.write(
      `${SERVER_INFO.name}: --token requires a value (or set ${HTTP_TOKEN_ENV}).\n`,
    );
    return 2;
  }
  if (args.help) {
    printHelp(process.stdout);
    return 0;
  }
  if (!args.projectRoot) {
    process.stderr.write(`${SERVER_INFO.name}: --project-root is required\n`);
    printHelp(process.stderr);
    return 2;
  }

  const projectRoot = canonicalProjectRoot(args.projectRoot);
  const storageDirectory = args.storageDirectory
    ? projectRelativeStorageDirectory(projectRoot, args.storageDirectory)
    : undefined;
  const port = new ProjectSageMemoryPort({
    projectRoot,
    ...(storageDirectory ? { directory: storageDirectory } : {}),
  });

  // Acquire (or lazily spawn) the SAGE IPC server. We don't lower this to
  // a try/catch around `port.initialize()` because the connection logic
  // already surfaces a precise message via `isSageProjectServerAvailable()`.
  try {
    await port.initialize();
  } catch (error) {
    await port.dispose().catch(() => undefined);
    process.stderr.write(
      `${SERVER_INFO.name}: cannot attach to SAGE project server for ${projectRoot}: ` +
        (error instanceof Error ? error.message : String(error)) +
        '\n',
    );
    return 3;
  }

  try {
    const server = createSageMcpServer(port, { writable: args.writable, projectRoot });

    if (args.transport === 'http') {
      const handle = await serveHttp(server, {
        port: args.httpPort,
        host: args.httpHost,
        ...(args.httpToken ? { token: args.httpToken } : {}),
        logger: { warn: (m) => process.stderr.write(`[sage-mcp] ${m}\n`) },
      });
      try {
        process.stderr.write(
          `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} ` +
            `transport=http writable=${String(args.writable)}${args.httpToken ? ' [token auth]' : ''}\n`,
        );
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            process.off('SIGINT', finish);
            process.off('SIGTERM', finish);
            resolve();
          };
          process.once('SIGINT', finish);
          process.once('SIGTERM', finish);
        });
      } finally {
        await handle.close();
      }
      return 0;
    }

    // stdio mode
    const handle = serveStdio(server);
    process.stderr.write(
      `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} ` +
        `transport=stdio writable=${String(args.writable)}\n`,
    );
    await handle.done;
    return 0;
  } finally {
    // Covers normal stdio EOF, HTTP signal shutdown, and setup failures after
    // the IPC-backed port has been initialized.
    await port.dispose();
  }
}

/**
 * Only run the CLI when this module IS the process entry point.
 *
 * `tests/cli.test.ts` imports `parseArgs` from here. Without this guard the
 * import ran `main()` inside the Vitest worker: Vitest's argv carries no
 * `--project-root`, so `main` printed the help block and set
 * `process.exitCode = 2`. The worker fork then exited mid-run and the pool's
 * next `send()` failed with `EPIPE` — surfacing as a single unhandled
 * "Worker forks emitted error" that failed the whole suite while every
 * individual test still passed.
 *
 * The comparison has to be real-path based: `file://${process.argv[1]}` never
 * matches on Windows (argv[1] is a backslash path, `import.meta.url` is a
 * percent-encoded forward-slash URL), and on POSIX argv[1] is the
 * `node_modules/.bin/wstack-sage-mcp` symlink rather than `dist/cli.js`.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (path.resolve(entry) === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${SERVER_INFO.name}: unexpected error\n`);
      process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.stderr.write('\n');
      process.exitCode = 1;
    },
  );
}
