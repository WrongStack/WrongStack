import * as path from 'node:path';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import { createRequirementIntakeMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

export interface ParsedArgs {
  projectRoot: string;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  /** `--token` given with no value: refused instead of serving without auth. */
  tokenMissing?: boolean | undefined;
  writable: boolean;
  actor?: string | undefined;
  help: boolean;
}

export function printHelp(stdout: NodeJS.WriteStream): void {
  stdout.write(
    [
      `${SERVER_INFO.name} v${SERVER_INFO.version} — WrongStack Requirements Intake MCP server`,
      '',
      'Usage:',
      `  ${SERVER_INFO.name} --project-root <path> [options]`,
      '',
      'Options:',
      '  --project-root <path>   Project whose requirement intakes should be served (required).',
      '  --stdio                 Use stdio transport (default).',
      '  --http                  Use HTTP transport.',
      '  --port <n>              HTTP port (default 0 = ephemeral).',
      '  --host <h>              HTTP bind host (default 127.0.0.1).',
      '  --token <t>             Bearer token. Required for a non-loopback HTTP bind.',
      '                          Prefer WRONGSTACK_MCP_TOKEN — a command line is readable',
      '                          by other local processes (WS-064).',
      '  --actor <id>            Actor id recorded as the intake requester.',
      '  --writable              Expose requirement_intake_submit (filing records).',
      '  -h, --help              Show this message.',
    ].join('\n') + '\n',
  );
}

/**
 * Environment variable carrying the HTTP auth token (WS-064) — same contract
 * as the Kanban MCP server. The flag wins when both are given.
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

  const warn = (event: string, message: string): void => {
    console.warn(
      JSON.stringify({ level: 'warn', event, message, timestamp: new Date().toISOString() }),
    );
  };

  const KNOWN_FLAGS = new Set([
    '--project-root',
    '--stdio',
    '--http',
    '--port',
    '--host',
    '--token',
    '--actor',
    '--writable',
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
      const trimmed = next.trim();
      if (trimmed.length === 0) {
        warn('mcp_cli_flag_missing_value', `${arg} expects a non-blank value; ignoring it.`);
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
        if (next !== undefined) parsed.projectRoot = path.resolve(next);
        break;
      }
      case '--stdio':
        parsed.transport = 'stdio';
        break;
      case '--http':
        parsed.transport = 'http';
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
      case '--actor': {
        const next = value();
        if (next !== undefined) parsed.actor = next;
        break;
      }
      case '--writable':
        if (switchOn()) parsed.writable = true;
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      default:
        if (arg?.startsWith('-')) warn('mcp_cli_unknown_option', `unknown option ${arg} ignored.`);
        break;
    }
  }
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
  if (!args.projectRoot) {
    process.stderr.write(`${SERVER_INFO.name}: --project-root is required\n`);
    printHelp(process.stderr);
    return 2;
  }

  const projectRoot = canonicalProjectRoot(args.projectRoot);
  const server = createRequirementIntakeMcpServer(projectRoot, {
    writable: args.writable,
    ...(args.actor ? { actor: args.actor } : {}),
  });
  const policyText = `writable=${String(args.writable)}`;

  if (args.transport === 'http') {
    const handle = await serveHttp(server, {
      port: args.httpPort,
      host: args.httpHost,
      ...(args.httpToken ? { token: args.httpToken } : {}),
      logger: { warn: (message) => process.stderr.write(`[requirement-intake-mcp] ${message}\n`) },
    });
    try {
      process.stderr.write(
        `${SERVER_INFO.name}: ready at ${handle.url} — projectRoot=${projectRoot} transport=http ${policyText}${
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
    `${SERVER_INFO.name}: ready on stdio — projectRoot=${projectRoot} transport=stdio ${policyText}\n`,
  );
  await handle.done;
  return 0;
}
