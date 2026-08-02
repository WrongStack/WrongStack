#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import {
  checkCodebaseIndexServerHealth,
  ensureCodebaseIndexServer,
  resolveProjectIndexDaemonAvailability,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools/codebase-index';
import { createCodebaseIndexMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

export interface ParsedArgs {
  projectRoot: string;
  indexDir?: string | undefined;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  writable: boolean;
  help: boolean;
}

export function printHelp(stdout: NodeJS.WriteStream): void {
  stdout.write(
    [
      `${SERVER_INFO.name} v${SERVER_INFO.version} — WrongStack Codebase Index MCP server`,
      '',
      'Usage:',
      `  ${SERVER_INFO.name} --project-root <path> [options]`,
      '',
      'Options:',
      '  --project-root <path>   Project whose IPC-backed index should be served (required).',
      '  --index-dir <path>      Override the project Codebase Index directory.',
      '  --stdio                 Use stdio transport (default).',
      '  --http                  Use HTTP transport.',
      '  --port <n>              HTTP port (default 0 = ephemeral).',
      '  --host <h>              HTTP bind host (default 127.0.0.1).',
      '  --token <t>             Bearer token. Required for a non-loopback HTTP bind.',
      '                          Prefer WRONGSTACK_MCP_TOKEN — a command line is readable',
      '                          by other local processes (WS-064).',
      '  --writable              Also expose codebase_index for incremental/full rebuilds.',
      '  -h, --help              Show this message.',
      '',
      'The MCP process is an IPC client. The detached project daemon remains the only SQLite owner.',
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
  const parsed: ParsedArgs = {
    projectRoot: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--project-root':
        parsed.projectRoot = path.resolve(argv[++index] ?? '');
        break;
      case '--index-dir':
        parsed.indexDir = path.resolve(argv[++index] ?? '');
        break;
      case '--stdio':
        parsed.transport = 'stdio';
        break;
      case '--http':
        parsed.transport = 'http';
        break;
      case '--port':
        parsed.httpPort = Number(argv[++index] ?? '') || 0;
        break;
      case '--host':
        parsed.httpHost = argv[++index] ?? '127.0.0.1';
        break;
      case '--token':
        parsed.httpToken = argv[++index];
        break;
      case '--writable':
        parsed.writable = true;
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      default:
        break;
    }
  }
  // WS-064: fall back to the environment, and warn when the token came from
  // the command line where other local processes can read it.
  if (parsed.httpToken === undefined) {
    const fromEnv = env[HTTP_TOKEN_ENV]?.trim();
    if (fromEnv) parsed.httpToken = fromEnv;
  } else if (parsed.httpToken.length > 0) {
    console.warn(
      `[mcp] --token puts the auth token in this process's command line, which other ` +
        `local processes can read. Prefer ${HTTP_TOKEN_ENV}.`,
    );
  }
  return parsed;
}

function availabilityError(
  availability: ReturnType<typeof resolveProjectIndexDaemonAvailability>,
): string | null {
  if (availability.kind === 'available') return null;
  if (availability.kind === 'inline-requested') {
    return 'the Codebase Index daemon is disabled by WRONGSTACK_INDEX_INLINE or WRONGSTACK_INDEX_SERVER=0';
  }
  if (availability.kind === 'missing-build') {
    return 'the @wrongstack/tools Codebase Index project-server build is missing';
  }
  return (
    `the IPC endpoint is too long (${availability.byteLength}/${availability.maxBytes} bytes): ` +
    availability.endpoint
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
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
  const availability = resolveProjectIndexDaemonAvailability(projectRoot, args.indexDir);
  const unavailable = availabilityError(availability);
  if (unavailable) {
    process.stderr.write(`${SERVER_INFO.name}: cannot use project-scoped IPC: ${unavailable}\n`);
    return 3;
  }

  // The shared IPC client's spawn-retry timers are intentionally unref'ed so
  // background callers do not keep a normal CLI alive. A standalone MCP
  // process has no other referenced handle before its transport starts, so it
  // needs a short startup lease while the first project daemon is elected.
  const startupLease = setInterval(() => {}, 1_000);
  try {
    await ensureCodebaseIndexServer({
      projectRoot,
      ...(args.indexDir ? { indexDir: args.indexDir } : {}),
      watchExternal: false,
    });
    const health = await checkCodebaseIndexServerHealth(projectRoot, args.indexDir);
    if (health.status === 'unresponsive') {
      throw new Error('project server health check was unresponsive');
    }
  } catch (error) {
    await shutdownCodebaseIndexHost();
    process.stderr.write(
      `${SERVER_INFO.name}: cannot attach to Codebase Index project server for ${projectRoot}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 3;
  } finally {
    clearInterval(startupLease);
  }

  const server = createCodebaseIndexMcpServer(projectRoot, {
    writable: args.writable,
    ...(args.indexDir ? { indexDir: args.indexDir } : {}),
  });
  const policyText = `writable=${String(args.writable)}`;

  if (args.transport === 'http') {
    try {
      const handle = await serveHttp(server, {
        port: args.httpPort,
        host: args.httpHost,
        ...(args.httpToken ? { token: args.httpToken } : {}),
        logger: { warn: (message) => process.stderr.write(`[codebase-index-mcp] ${message}\n`) },
      });
      process.stderr.write(
        `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} transport=http ${policyText}${
          args.httpToken ? ' [token auth]' : ''
        }\n`,
      );
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await handle.close();
      return 0;
    } finally {
      await shutdownCodebaseIndexHost();
    }
  }

  try {
    const handle = serveStdio(server);
    process.stderr.write(
      `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} transport=stdio ${policyText}\n`,
    );
    await handle.done;
    return 0;
  } finally {
    await shutdownCodebaseIndexHost();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const comparablePath = (value: string): string => {
    const normalized = path.resolve(value).replace(/^\\\\\?\\/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (comparablePath(entry) === comparablePath(self)) return true;
  try {
    return comparablePath(realpathSync(entry)) === comparablePath(realpathSync(self));
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
