import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { serveHttp, serveStdio } from '@wrongstack/mcp';
import {
  checkCodebaseIndexServerHealth,
  type EmbeddingPort,
  ensureCodebaseIndexServer,
  resolveIndexRoute,
  resolveProjectIndexDaemonAvailability,
  runStartupIndex,
  setContextQueryEmbedder,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools/codebase-index';
import { createCodebaseIndexMcpServer } from './adapter.js';
import { SERVER_INFO } from './version.js';

const EXPECTED_EMBEDDING_DIMENSIONS = 384;

/**
 * Best-effort host-side semantic embedding model wiring for `codebase_context`.
 * Uses dynamic import so `@wrongstack/vector-memory` / `@huggingface/transformers`
 * remain optional and never delay or fail MCP server startup.
 */
export async function tryConfigureMcpEmbeddingPort(): Promise<EmbeddingPort | undefined> {
  try {
    const vectorMemModule = '@wrongstack/vector-memory';
    const mod = (await import(vectorMemModule)) as {
      TransformersEmbeddingProvider?: new () => EmbeddingPort & {
        isAvailable(): Promise<boolean>;
      };
    };
    if (typeof mod.TransformersEmbeddingProvider !== 'function') return undefined;
    const provider = new mod.TransformersEmbeddingProvider();
    if (!(await provider.isAvailable())) return undefined;
    if (provider.dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) return undefined;
    setContextQueryEmbedder(provider);
    return provider;
  } catch {
    return undefined;
  }
}

export interface ParsedArgs {
  projectRoot: string;
  indexDir?: string | undefined;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
  httpToken?: string | undefined;
  /** `--token` given with no value: refused instead of serving without auth. */
  tokenMissing?: boolean | undefined;
  writable: boolean;
  watch: boolean;
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
      '  --watch                 Keep the index fresh while connected: catch up incrementally',
      '                          at start, then reindex files changed on disk.',
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
    watch: false,
    help: false,
  };

  const warn = (event: string, message: string): void => {
    console.warn(
      JSON.stringify({ level: 'warn', event, message, timestamp: new Date().toISOString() }),
    );
  };

  const KNOWN_FLAGS = new Set([
    '--project-root',
    '--index-dir',
    '--stdio',
    '--http',
    '--port',
    '--host',
    '--token',
    '--writable',
    '--watch',
    '-h',
    '--help',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const rawArg = argv[index] ?? '';
    // `--token=<t>` fell to the unknown-option warning, which dropped the
    // token and echoed it to stderr, like the sibling servers before 4ec736bf8.
    const eqIndex = rawArg.startsWith('--') ? rawArg.indexOf('=') : -1;
    const arg = eqIndex > 0 ? rawArg.slice(0, eqIndex) : rawArg;
    const inlineValue = eqIndex > 0 ? rawArg.slice(eqIndex + 1) : undefined;
    // A value-taking flag must be followed by a value. `path.resolve('')` is
    // the cwd, so a bare `--project-root` used to serve whatever directory the
    // MCP client happened to launch in, and swallowed the next flag as a value.
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
    // was written to deny. `true`/`1` keep the switch; `false`/`0` clear it.
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
        const v = value();
        if (v !== undefined) parsed.projectRoot = path.resolve(v);
        break;
      }
      case '--index-dir': {
        const v = value();
        if (v !== undefined) parsed.indexDir = path.resolve(v);
        break;
      }
      case '--stdio':
        if (parseSwitch(false)) parsed.transport = 'stdio';
        break;
      case '--http':
        if (parseSwitch(false)) parsed.transport = 'http';
        break;
      case '--port': {
        const v = value();
        if (v === undefined) break;
        const port = Number(v);
        if (Number.isInteger(port) && port >= 0 && port <= 65_535) parsed.httpPort = port;
        else
          warn('mcp_cli_invalid_port', `--port ${v} is not a valid port; using an ephemeral port.`);
        break;
      }
      case '--host': {
        const v = value();
        if (v !== undefined) parsed.httpHost = v;
        break;
      }
      case '--token': {
        const v = value(true);
        if (v !== undefined) {
          parsed.httpToken = v;
          parsed.tokenMissing = false;
        } else if (parsed.httpToken === undefined) {
          parsed.tokenMissing = true;
        }
        break;
      }
      case '--writable':
        parsed.writable = parseSwitch(parsed.writable);
        break;
      case '--watch':
        parsed.watch = parseSwitch(parsed.watch);
        break;
      case '-h':
      case '--help':
        parsed.help = parseSwitch(parsed.help);
        break;
      default:
        // A typo such as `--writeable` silently served a read-only server.
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

/** Resolve the checkout whose source files and local index are served. */
export function resolveIndexProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  try {
    // Canonicalize filesystem aliases without collapsing a linked Git
    // worktree into its main checkout. Codebase Index storage is local to the
    // physical checkout because each worktree can contain different source.
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
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

  const projectRoot = resolveIndexProjectRoot(args.projectRoot);
  // Served by the WrongIndex service (WRONGSTACK_INDEX_SERVICE, or an index
  // it owns in `auto`): no local project daemon is needed.
  const viaService = resolveIndexRoute(projectRoot, args.indexDir) === 'wrongindex';
  const availability = resolveProjectIndexDaemonAvailability(projectRoot, args.indexDir);
  const unavailable = viaService ? null : availabilityError(availability);
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
      // A client that edits outside WrongStack (an external agent) makes the
      // index stale unless the project server watches the disk for it.
      watchExternal: args.watch,
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

  if (args.watch) {
    // Catch up on edits made while nobody was watching. Incremental and
    // change-proportional; queries are served meanwhile from the last index.
    void runStartupIndex({ projectRoot, ...(args.indexDir ? { indexDir: args.indexDir } : {}) })
      .then((result) =>
        process.stderr.write(
          `${SERVER_INFO.name}: index caught up (${JSON.stringify(result).slice(0, 160)})
`,
        ),
      )
      .catch((error: unknown) =>
        process.stderr.write(
          `${SERVER_INFO.name}: index catch-up failed: ${
            error instanceof Error ? error.message : String(error)
          }
`,
        ),
      );
  }

  const server = createCodebaseIndexMcpServer(projectRoot, {
    writable: args.writable,
    ...(args.indexDir ? { indexDir: args.indexDir } : {}),
  });
  void tryConfigureMcpEmbeddingPort();
  const policyText = `writable=${String(args.writable)} watch=${String(args.watch)}`;

  if (args.transport === 'http') {
    try {
      const handle = await serveHttp(server, {
        port: args.httpPort,
        host: args.httpHost,
        ...(args.httpToken ? { token: args.httpToken } : {}),
        logger: { warn: (message) => process.stderr.write(`[codebase-index-mcp] ${message}\n`) },
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
