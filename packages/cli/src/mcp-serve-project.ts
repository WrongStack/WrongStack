/**
 * `wstack mcp serve <mailbox|kanban|codebase-index|requirement-intake|sage>` — run one of
 * WrongStack's project MCP servers from inside `wstack` itself.
 *
 * Mailbox, Kanban, Codebase Index and Requirements Intake also ship as their own npm bins
 * (`wstack-mailbox-mcp`, …), but the standalone binary carries none of them,
 * so this is the launch path that works in every install. Each server is bound
 * to one project: `--project-root` defaults to the project this command runs
 * in, and every server only attaches to that project's running owner.
 *
 * stdout is the JSON-RPC channel; everything else goes to stderr.
 */
import type { SubcommandDeps } from './subcommands/contracts.js';
import { restoreFlags } from './subcommands/flags.js';

const PROJECT_MCP_SERVERS = [
  'mailbox',
  'kanban',
  'codebase-index',
  'requirement-intake',
  'sage',
] as const;
export type ProjectMcpServer = (typeof PROJECT_MCP_SERVERS)[number];

export function isProjectMcpServer(value: string | undefined): value is ProjectMcpServer {
  return (PROJECT_MCP_SERVERS as readonly (string | undefined)[]).includes(value);
}

/** Every flag the project servers read; the global parser strips them first. */
const SERVER_FLAGS = [
  'project-root',
  'actor',
  'session-id',
  'name',
  'role',
  'writable',
  'admin',
  'destructive',
  'http',
  'stdio',
  'port',
  'host',
  'token',
  'index-dir',
  'origin',
  'watch',
] as const;

/** Switches in the servers' own parsers. */
const SWITCHES = new Set([
  '--writable',
  '--admin',
  '--destructive',
  '--http',
  '--stdio',
  '--watch',
]);

/**
 * The global parser treats every flag here as valued, so `--writable` written
 * before another word comes back as `--writable <word>`, and `--writable=true`
 * as `--writable true`. The servers read these as bare switches.
 */
function normalizeSwitches(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!SWITCHES.has(flag)) {
      out.push(arg);
      continue;
    }
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === 'false') continue;
    out.push(flag);
    if (eq === -1 && args[i + 1] === 'true') i++;
  }
  return out;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === flag) {
      const next = args[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : undefined;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export async function serveProjectMcp(
  server: ProjectMcpServer,
  rawArgs: string[],
  deps: SubcommandDeps,
): Promise<number> {
  const args = normalizeSwitches(restoreFlags(rawArgs, deps, SERVER_FLAGS));
  // A blank root (a launcher's `${workspaceFolder}` that expanded to nothing)
  // is not "absent": `?? deps.projectRoot` kept it, and "" resolves to the
  // client's cwd — a different project's daemon.
  const explicitRoot = optionValue(args, 'project-root');
  if (explicitRoot !== undefined && explicitRoot.trim() === '') {
    process.stderr.write('wstack mcp serve: --project-root expects a non-blank path.\n');
    return 2;
  }
  if (server === 'sage') {
    const projectRoot = optionValue(args, 'project-root') ?? deps.projectRoot;
    const { wrongMemorySageOwner, serveWrongMemoryMcp } = await import('./sage-mcp-owner.js');
    const owner = await wrongMemorySageOwner(projectRoot, deps.config.Sage?.service);
    if (owner) {
      // One memory owner: WrongMemory's own bridge under a scoped grant.
      return serveWrongMemoryMcp(
        owner,
        projectRoot,
        deps.config.Sage?.service,
        optionValue(args, 'origin')?.trim() || 'mcp-client',
        'wstack mcp serve sage',
      );
    }
    const { serveAttachedSageMcpStdio } = await import('@wrongstack/sage-mcp');
    await serveAttachedSageMcpStdio({
      // A client may start this server from any directory; an explicit root wins.
      projectRoot,
      directory: deps.config.Sage?.storage?.directory,
      origin: optionValue(args, 'origin')?.trim() || 'mcp-client',
    });
    return 0;
  }
  const argv =
    optionValue(args, 'project-root') === undefined
      ? [...args, '--project-root', deps.projectRoot]
      : args;
  // Literal specifiers: the standalone binary cannot resolve a computed one.
  if (server === 'mailbox') {
    const { runMailboxMcpServer } = await import('@wrongstack/mailbox-mcp');
    return runMailboxMcpServer(argv);
  }
  if (server === 'kanban') {
    const { runKanbanMcpServer } = await import('@wrongstack/kanban-mcp');
    return runKanbanMcpServer(argv);
  }
  if (server === 'requirement-intake') {
    const { runRequirementIntakeMcpServer } = await import('@wrongstack/requirement-intake-mcp');
    return runRequirementIntakeMcpServer(argv);
  }
  const { runCodebaseIndexMcpServer } = await import('@wrongstack/codebase-index-mcp');
  return runCodebaseIndexMcpServer(argv);
}
