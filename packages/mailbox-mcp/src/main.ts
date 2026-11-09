import * as path from 'node:path';
import {
  createProjectMailbox,
  MailboxEventEmitter,
  resolveProjectDir,
} from '@wrongstack/coordination';
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
  /** `--token` given with no value: refused instead of serving without auth. */
  tokenMissing?: boolean | undefined;
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
      '                          Prefer WRONGSTACK_MCP_TOKEN — a command line is readable',
      '                          by other local processes (WS-064).',
      '  --writable              Expose send, receipts, soft-delete/restore, and self-presence.',
      '  --admin                 Expose full maintenance and credential operations; implies writable.',
      '  -h, --help              Show this message.',
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
    actor: '',
    transport: 'stdio',
    httpPort: 0,
    httpHost: '127.0.0.1',
    writable: false,
    admin: false,
    help: false,
  };
  const warn = (event: string, message: string): void => {
    console.warn(
      JSON.stringify({ level: 'warn', event, message, timestamp: new Date().toISOString() }),
    );
  };
  const KNOWN_FLAGS = new Set([
    '--project-root',
    '--actor',
    '--session-id',
    '--name',
    '--role',
    '--stdio',
    '--http',
    '--port',
    '--host',
    '--token',
    '--writable',
    '--admin',
    '-h',
    '--help',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const rawArg = argv[index] ?? '';
    const eqIndex = rawArg.startsWith('--') ? rawArg.indexOf('=') : -1;
    const arg = eqIndex > 0 ? rawArg.slice(0, eqIndex) : rawArg;
    const inlineValue = eqIndex > 0 ? rawArg.slice(eqIndex + 1) : undefined;
    // A secret may begin with "-" (base64url); refusing it dropped the token
    // and echoed it to stderr as an unknown option.
    const value = (allowDash = false): string | undefined => {
      if (inlineValue !== undefined) {
        const trimmedInline = inlineValue.trim();
        if (trimmedInline.length === 0) {
          warn('mcp_cli_flag_missing_value', `${arg} expects a non-blank value; ignoring it.`);
          return undefined;
        }
        return trimmedInline;
      }
      const next = argv[index + 1];
      const nextFlag = next?.startsWith('--') ? (next.split('=', 1)[0] ?? next) : next;
      if (
        next === undefined ||
        (nextFlag !== undefined && KNOWN_FLAGS.has(nextFlag)) ||
        (!allowDash && next.startsWith('-'))
      ) {
        warn('mcp_cli_flag_missing_value', `${arg} expects a value; ignoring it.`);
        return undefined;
      }
      index++;
      // A blank value (an unset launcher variable) resolved `--project-root`
      // to the cwd; ignore it like the sibling servers do.
      const trimmed = next.trim();
      if (trimmed.length === 0) {
        warn('mcp_cli_flag_missing_value', `${arg} expects a non-blank value; ignoring it.`);
        return undefined;
      }
      return trimmed;
    };
    // A switch takes no value, but `--writable=false` used to GRANT the tier it
    // was written to deny. `true`/`1` set the switch; `false`/`0` clear it.
    const parseSwitch = (current: boolean): boolean => {
      if (inlineValue === undefined) return true;
      const flag = inlineValue.trim().toLowerCase();
      if (flag === 'true' || flag === '1') return true;
      if (flag === 'false' || flag === '0') return false;
      warn('mcp_cli_flag_invalid_switch', `${arg} takes no value; ignoring it.`);
      return current;
    };
    switch (arg) {
      case '--project-root': {
        const next = value();
        if (next !== undefined) parsed.projectRoot = path.resolve(next);
        break;
      }
      case '--actor': {
        const next = value();
        if (next !== undefined) parsed.actor = next;
        break;
      }
      case '--session-id': {
        const next = value();
        if (next !== undefined) parsed.sessionId = next;
        break;
      }
      case '--name': {
        const next = value();
        if (next !== undefined) parsed.actorName = next;
        break;
      }
      case '--role': {
        const next = value();
        if (next !== undefined) parsed.actorRole = next;
        break;
      }
      case '--stdio':
        if (parseSwitch(parsed.transport === 'stdio')) parsed.transport = 'stdio';
        break;
      case '--http':
        if (parseSwitch(parsed.transport === 'http')) parsed.transport = 'http';
        break;
      case '--port': {
        const next = value();
        if (next === undefined) break;
        const port = Number(next);
        if (Number.isInteger(port) && port >= 0 && port <= 65_535) parsed.httpPort = port;
        else warn('mcp_cli_invalid_port', `--port ${next} is not a valid port; using 0.`);
        break;
      }
      case '--host': {
        const next = value();
        if (next !== undefined) parsed.httpHost = next;
        break;
      }
      case '--token': {
        const next = value(true);
        if (next !== undefined) {
          parsed.httpToken = next;
          parsed.tokenMissing = false;
        } else if (parsed.httpToken === undefined) {
          parsed.tokenMissing = true;
        }
        break;
      }
      case '--writable':
        parsed.writable = parseSwitch(parsed.writable);
        break;
      case '--admin': {
        const nextAdmin = parseSwitch(parsed.admin);
        parsed.admin = nextAdmin;
        if (nextAdmin) parsed.writable = true;
        break;
      }
      case '-h':
      case '--help':
        parsed.help = parseSwitch(parsed.help);
        break;
      default:
        if (arg?.startsWith('-')) warn('mcp_cli_unknown_option', `unknown option ${arg} ignored.`);
        break;
    }
  }
  // WS-064: fall back to the environment, and warn when the token came from
  // the command line where other local processes can read it.
  if (parsed.httpToken === undefined) {
    const fromEnv = env[HTTP_TOKEN_ENV]?.trim();
    if (fromEnv) {
      parsed.httpToken = fromEnv;
      parsed.tokenMissing = false;
    }
  } else if (parsed.httpToken.length > 0) {
    console.warn(
      `[mcp] --token puts the auth token in this process's command line, which other ` +
        `local processes can read. Prefer ${HTTP_TOKEN_ENV}.`,
    );
  }
  return parsed;
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

  try {
    if (args.transport === 'http') {
      const handle = await serveHttp(server, {
        port: args.httpPort,
        host: args.httpHost,
        ...(args.httpToken ? { token: args.httpToken } : {}),
        logger: { warn: (message) => process.stderr.write(`[mailbox-mcp] ${message}\n`) },
      });
      try {
        process.stderr.write(
          `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} actor=${args.actor} transport=http ${policyText}${
            args.httpToken ? ' [token auth]' : ''
          }\n`,
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

    const handle = serveStdio(server);
    process.stderr.write(
      `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} actor=${args.actor} transport=stdio ${policyText}\n`,
    );
    await handle.done;
    return 0;
  } finally {
    await mailbox.close();
  }
}
