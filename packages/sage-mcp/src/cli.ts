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
import * as path from 'node:path';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import {
  ProjectSageMemoryPort,
  isSageProjectServerAvailable,
} from '@wrongstack/sage';
import { createSageMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

interface ParsedArgs {
  projectRoot: string;
  storageDirectory?: string | undefined;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
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
      '  --writable              Expose standard-tier (write/delete) tools.',
      '  -h, --help              Show this message.',
      '',
      'Existing SAGE IPC server connection:',
      `  isSageProjectServerAvailable() = ${String(isSageProjectServerAvailable())}`,
    ].join('\n') + '\n',
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    projectRoot: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--project-root':
        out.projectRoot = path.resolve(argv[++i] ?? '');
        break;
      case '--storage-dir':
        out.storageDirectory = path.resolve(argv[++i] ?? '');
        break;
      case '--stdio':
        out.transport = 'stdio';
        break;
      case '--http':
        out.transport = 'http';
        break;
      case '--port':
        out.httpPort = Number(argv[++i] ?? '') || 0;
        break;
      case '--host':
        out.httpHost = argv[++i] ?? '127.0.0.1';
        break;
      case '--token':
        out.httpToken = argv[++i];
        break;
      case '--writable':
        out.writable = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        // ignore unknown flags (forward-compat)
        break;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
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
  const port = new ProjectSageMemoryPort({
    projectRoot,
    ...(args.storageDirectory ? { directory: args.storageDirectory } : {}),
  });

  // Acquire (or lazily spawn) the SAGE IPC server. We don't lower this to
  // a try/catch around `port.initialize()` because the connection logic
  // already surfaces a precise message via `isSageProjectServerAvailable()`.
  try {
    await port.initialize();
  } catch (error) {
    process.stderr.write(
      `${SERVER_INFO.name}: cannot attach to SAGE project server for ${projectRoot}: ` +
        (error instanceof Error ? error.message : String(error)) +
        '\n',
    );
    return 3;
  }

  const server = createSageMcpServer(port, { writable: args.writable });

  if (args.transport === 'http') {
    const handle = await serveHttp(server, {
      port: args.httpPort,
      host: args.httpHost,
      ...(args.httpToken ? { token: args.httpToken } : {}),
      logger: { warn: (m) => process.stderr.write(`[sage-mcp] ${m}\n`) },
    });
    process.stderr.write(
      `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} ` +
        `transport=http writable=${String(args.writable)}${args.httpToken ? ' [token auth]' : ''}\n`,
    );
    return await new Promise<number>((resolve) => {
      const stop = () => resolve(0);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }

  // stdio mode
  const handle = serveStdio(server);
  process.stderr.write(
    `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} ` +
      `transport=stdio writable=${String(args.writable)}\n`,
  );
  await handle.done;
  await port.dispose();
  return 0;
}

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
