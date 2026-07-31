#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { closeKanbanServerConnections, getKanbanServerConnection } from '@wrongstack/kanban';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import { createKanbanMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

export interface ParsedArgs {
  projectRoot: string;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  writable: boolean;
  destructive: boolean;
  actor?: string | undefined;
  help: boolean;
}

export function printHelp(stdout: NodeJS.WriteStream): void {
  stdout.write(
    [
      `${SERVER_INFO.name} v${SERVER_INFO.version} — WrongStack Kanban MCP server`,
      '',
      'Usage:',
      `  ${SERVER_INFO.name} --project-root <path> [options]`,
      '',
      'Options:',
      '  --project-root <path>   Project whose IPC-backed Kanban should be served (required).',
      '  --stdio                 Use stdio transport (default).',
      '  --http                  Use HTTP transport.',
      '  --port <n>              HTTP port (default 0 = ephemeral).',
      '  --host <h>              HTTP bind host (default 127.0.0.1).',
      '  --token <t>             Bearer token. Required for a non-loopback HTTP bind.',
      '  --actor <id>            Actor id recorded in Kanban activity/events.',
      '  --writable              Expose non-destructive board/task management.',
      '  --destructive           Also expose delete/merge/transfer; implies --writable.',
      '  -h, --help              Show this message.',
    ].join('\n') + '\n',
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    destructive: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--project-root':
        parsed.projectRoot = path.resolve(argv[++index] ?? '');
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
      case '--actor':
        parsed.actor = argv[++index];
        break;
      case '--writable':
        parsed.writable = true;
        break;
      case '--destructive':
        parsed.destructive = true;
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
  return parsed;
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
  try {
    const connection = await getKanbanServerConnection(projectRoot);
    if (!connection) throw new Error('Kanban project server is disabled');
    await connection.request('ping', {});
  } catch (error) {
    process.stderr.write(
      `${SERVER_INFO.name}: cannot attach to Kanban project server for ${projectRoot}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 3;
  }

  const server = createKanbanMcpServer(projectRoot, {
    writable: args.writable,
    destructive: args.destructive,
    ...(args.actor ? { actor: args.actor } : {}),
  });
  const policyText = `writable=${String(args.writable)} destructive=${String(args.destructive)}`;

  if (args.transport === 'http') {
    const handle = await serveHttp(server, {
      port: args.httpPort,
      host: args.httpHost,
      ...(args.httpToken ? { token: args.httpToken } : {}),
      logger: { warn: (message) => process.stderr.write(`[kanban-mcp] ${message}\n`) },
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
    closeKanbanServerConnections();
    return 0;
  }

  const handle = serveStdio(server);
  process.stderr.write(
    `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} transport=stdio ${policyText}\n`,
  );
  await handle.done;
  closeKanbanServerConnections();
  return 0;
}

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
