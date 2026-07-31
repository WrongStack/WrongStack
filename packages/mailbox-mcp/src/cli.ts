#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProjectMailbox,
  MailboxEventEmitter,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { canonicalProjectRoot, wstackGlobalRoot } from '@wrongstack/core/utils';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import { createMailboxMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

export interface ParsedArgs {
  projectRoot: string;
  actor: string;
  sessionId?: string | undefined;
  actorName?: string | undefined;
  actorRole?: string | undefined;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  writable: boolean;
  admin: boolean;
  help: boolean;
}

export function printHelp(stdout: NodeJS.WriteStream): void {
  stdout.write(
    [
      `${SERVER_INFO.name} v${SERVER_INFO.version} — WrongStack Mailbox MCP server`,
      '',
      'Usage:',
      `  ${SERVER_INFO.name} --project-root <path> --actor <id> [options]`,
      '',
      'Options:',
      '  --project-root <path>   Project whose IPC-backed Mailbox should be served (required).',
      '  --actor <id>            Stable external agent id used for sends and receipts (required).',
      '  --session-id <id>       Stable session id for @session routing and presence.',
      '  --name <name>           Human-readable agent name.',
      '  --role <role>           Optional agent role.',
      '  --stdio                 Use stdio transport (default).',
      '  --http                  Use HTTP transport.',
      '  --port <n>              HTTP port (default 0 = ephemeral).',
      '  --host <h>              HTTP bind host (default 127.0.0.1).',
      '  --token <t>             Bearer token. Required for a non-loopback HTTP bind.',
      '  --writable              Expose send, receipts, soft-delete/restore, and self-presence.',
      '  --admin                 Expose full maintenance and credential operations; implies writable.',
      '  -h, --help              Show this message.',
    ].join('\n') + '\n',
  );
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: '',
    actor: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    admin: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--project-root':
        parsed.projectRoot = path.resolve(argv[++index] ?? '');
        break;
      case '--actor':
        parsed.actor = argv[++index] ?? '';
        break;
      case '--session-id':
        parsed.sessionId = argv[++index];
        break;
      case '--name':
        parsed.actorName = argv[++index];
        break;
      case '--role':
        parsed.actorRole = argv[++index];
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
      case '--admin':
        parsed.admin = true;
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
  if (!args.projectRoot || !args.actor.trim()) {
    process.stderr.write(`${SERVER_INFO.name}: --project-root and --actor are required\n`);
    printHelp(process.stderr);
    return 2;
  }

  const projectRoot = canonicalProjectRoot(args.projectRoot);
  const projectDir = resolveProjectDir(projectRoot, wstackGlobalRoot());
  const emitter = new MailboxEventEmitter();
  const mailbox = createProjectMailbox({ projectDir, eventEmitter: emitter });
  try {
    await mailbox.initialize();
  } catch (error) {
    await mailbox.close().catch(() => undefined);
    process.stderr.write(
      `${SERVER_INFO.name}: cannot attach to Mailbox project server for ${projectRoot}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 3;
  }

  const server = createMailboxMcpServer(mailbox, emitter, {
    actor: args.actor,
    writable: args.writable,
    admin: args.admin,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.actorName ? { actorName: args.actorName } : {}),
    ...(args.actorRole ? { actorRole: args.actorRole } : {}),
  });
  const policyText = `writable=${String(args.writable)} admin=${String(args.admin)}`;

  if (args.transport === 'http') {
    const handle = await serveHttp(server, {
      port: args.httpPort,
      host: args.httpHost,
      ...(args.httpToken ? { token: args.httpToken } : {}),
      logger: { warn: (message) => process.stderr.write(`[mailbox-mcp] ${message}\n`) },
    });
    process.stderr.write(
      `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} actor=${args.actor} transport=http ${policyText}${
        args.httpToken ? ' [token auth]' : ''
      }\n`,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await handle.close();
    await mailbox.close();
    return 0;
  }

  const handle = serveStdio(server);
  process.stderr.write(
    `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} actor=${args.actor} transport=stdio ${policyText}\n`,
  );
  await handle.done;
  await mailbox.close();
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
