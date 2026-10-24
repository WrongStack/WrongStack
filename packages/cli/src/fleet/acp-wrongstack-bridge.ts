/**
 * The WrongStack bridge for delegated ACP workers.
 *
 * When WrongStack hands a task to an external agent (Claude Code over ACP by
 * default), the agent keeps its own identity, tools and sign-in; it only
 * needs to know it is working inside this project and how to reach it. Each
 * session therefore gets:
 *   - the project's MCP servers, each launched as `wstack mcp serve <name>`
 *     with an explicit `--project-root` (works in the standalone binary, and
 *     attaches only to this project's running owner) — except the codebase
 *     index under `acp.bridge.indexSurface: 'cli'`, which the worker reaches
 *     through `wstack tools run codebase-*` from its own shell instead;
 *   - a short note appended to the agent's own system prompt, through the
 *     `_meta.systemPrompt.append` extension the Claude ACP adapter reads.
 *
 * Mailbox identity is per worker (`--actor` = subagent id) and `@session`
 * resolves to the WrongStack session that delegated the task.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { type AcpSessionSetup, findAgentDescriptor, REGISTRY_ID_ALIASES } from '@wrongstack/acp';
import type { Config, SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { cliSpawnArgs, isStandaloneBinary } from '@wrongstack/core/utils';

export type BridgeServer = 'sage' | 'mailbox' | 'kanban' | 'codebase-index' | 'requirement-intake';

export const DEFAULT_BRIDGE_AGENTS: readonly string[] = ['claude-code'];
export const DEFAULT_BRIDGE_SERVERS: readonly BridgeServer[] = [
  'codebase-index',
  'sage',
  'mailbox',
  'kanban',
];

type BridgeConfig = NonNullable<NonNullable<Config['acp']>['bridge']>;

interface StdioServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** How to start this same `wstack`: the binary itself, or node/bun + the CLI entry. */
export function wstackLaunch(
  args: string[],
  entry: string | undefined = process.argv[1],
): { command: string; args: string[] } {
  if (isStandaloneBinary() || (entry && /wstack|wrongstack|index\.(js|ts|mjs|cjs)$/.test(entry))) {
    return { command: process.execPath, args: cliSpawnArgs(entry ?? '', args) };
  }
  return { command: 'wstack', args };
}

/**
 * The worker's shell command for `wstack tools`, built from the same launcher
 * as the MCP servers so it reaches this exact install. Stable for a given
 * install, which keeps the system-prompt note cache-friendly across workers.
 * Windows paths use forward slashes: the agent's shell is usually Git Bash,
 * where an unquoted backslash is an escape.
 */
export function wstackToolsCommand(
  entry: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string {
  const launch = wstackLaunch(['tools'], entry);
  return [launch.command, ...launch.args].map((word) => shellWord(word, platform)).join(' ');
}

function shellWord(word: string, platform: NodeJS.Platform): string {
  const w = platform === 'win32' ? word.replace(/\\/g, '/') : word;
  return /^[A-Za-z0-9_./:@=+-]+$/.test(w) ? w : `"${w.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The note for the index reached through `wstack tools` instead of an MCP server. */
function cliIndexNote(cmd: string): string[] {
  return [
    `- \`${cmd} run <tool> -- --<field> <value>\` (run through your shell): a prebuilt, ranked`,
    '  symbol index of this repository, caught up with the disk on every call. Prefer it over',
    '  grep/glob and whole-file reads for code navigation: codebase-context --query "<task>"',
    '  (files relevant to a task), codebase-search --query <name> (where something is defined),',
    '  codebase-incoming-calls / codebase-outgoing-calls --symbol <name> (callers, callees),',
    "  codebase-read-symbol --file <path> --symbol <name> (one symbol's source),",
    '  codebase-skeleton --path <file-or-dir> (an outline), codebase-impact-analysis --symbol',
    `  <name> (what a change affects). \`${cmd} describe <tool>\` lists a tool's fields;`,
    `  \`${cmd} batch\` runs several JSONL calls ({"tool":…,"input":…}) in one process.`,
    '  Use grep for literal text such as strings, comments and config values.',
  ];
}

/** Service notes: the MCP servers, then the index's CLI surface when it is on. */
function serviceNotes(
  servers: readonly BridgeServer[],
  delegated: boolean,
  indexCli: string | undefined,
): string[] {
  const viaCli = indexCli !== undefined && servers.includes('codebase-index');
  const mcp = viaCli ? servers.filter((s) => s !== 'codebase-index') : servers;
  return [
    ...(mcp.length > 0
      ? [
          "WrongStack's project services are available as MCP servers:",
          ...mcp.map((s) => SERVER_NOTES[s](delegated)),
        ]
      : []),
    ...(viaCli
      ? [
          ...(mcp.length > 0 ? [''] : []),
          "WrongStack's codebase index is available through its CLI:",
          ...cliIndexNote(indexCli),
        ]
      : []),
  ];
}

const SERVER_NAMES: Record<BridgeServer, string> = {
  sage: 'wrongstack-sage',
  mailbox: 'wrongstack-mailbox',
  kanban: 'wrongstack-kanban',
  'codebase-index': 'wrongstack-index',
  'requirement-intake': 'wrongstack-intake',
};

const SERVER_NOTES: Record<BridgeServer, (delegated: boolean) => string> = {
  sage: () =>
    "- wrongstack-sage: the project's shared memory. Recall what is relevant before you " +
    'start; when you learn something durable (a decision, a gotcha, a convention), propose ' +
    'it with memory_candidates (WrongStack reviews proposals).',
  mailbox: (delegated) =>
    "- wrongstack-mailbox: the project's agent mailbox, already signed in as you. Send progress, " +
    'blockers and questions to ' +
    (delegated
      ? '"@session" (the WrongStack session that delegated this task), '
      : '"all" (the agents working in this project), ') +
    '(a send needs a type, e.g. "note"), check unread mail during long work, and acknowledge ' +
    'what you handle.',
  kanban: () =>
    "- wrongstack-kanban: the project's board. If the task names a card, keep its status " +
    'current. Lists return only the most recently updated (pass limit for more); use the ' +
    'stats action for totals and workbench for what is in flight.',
  'codebase-index': () =>
    '- wrongstack-index: a prebuilt, ranked symbol index of this repository, kept fresh by ' +
    'WrongStack. Prefer it over grep/glob and whole-file reads for code navigation: ' +
    'codebase_search (where something is defined), codebase_incoming_calls / ' +
    "codebase_outgoing_calls (callers, callees), codebase_read_symbol (one symbol's source), " +
    'codebase_skeleton (a file or folder outline), codebase_impact_analysis (what a change ' +
    'affects), codebase_context (files relevant to a task), codebase_repo_map (overview). ' +
    'Use grep for literal text such as strings, comments and config values.',
  'requirement-intake': () =>
    "- wrongstack-intake: the project's requirements intake. List open requests; file a new " +
    'one when you are handed an unrecorded software request.',
};

function serviceWorkflow(servers: readonly BridgeServer[], indexCli?: string): string[] {
  return [
    ...(servers.includes('codebase-index')
      ? indexCli !== undefined
        ? [
            'Use the WrongStack index first for code navigation; use your file tools for edits,',
            'exact literal searches, and verification. Start a code task with',
            `${indexCli} run codebase-context -- --query "<the task in a few words>"; for a named`,
            `symbol use ${indexCli} run codebase-search -- --query <name>. If the index lacks a`,
            'result, fall back to your tools.',
          ]
        : [
            'Use wrongstack-index first for code navigation; use your file tools for edits, exact',
            'literal searches, and verification. Start a code task with',
            'mcp__wrongstack-index__codebase_context (task description); for a named symbol use',
            'mcp__wrongstack-index__codebase_search. If the index lacks a result, fall back to your tools.',
          ]
      : []),
    ...(servers.includes('sage')
      ? [
          'Recall relevant decisions from wrongstack-sage before substantial work; propose durable',
          'findings to memory_candidates after verification. Start with',
          'mcp__wrongstack-sage__memory_search using the task topic.',
        ]
      : []),
    ...(servers.includes('mailbox')
      ? [
          'Check wrongstack-mailbox for unread messages when starting and during long work;',
          'use mcp__wrongstack-mailbox__mailbox_read with action "inbox" to read your',
          'messages. Send meaningful',
          'progress or blockers and acknowledge messages you handle.',
        ]
      : []),
    ...(servers.includes('kanban')
      ? [
          'Use wrongstack-kanban when work is tied to a board task; inspect its current state',
          'with mcp__wrongstack-kanban__kanban_read and update it as work progresses.',
        ]
      : []),
    'If a project service is unavailable, continue with available tools and report the gap.',
  ];
}

/** A short task-local cue: the Claude adapter gives user-turn text more immediate weight. */
export function bridgeTaskKickoff(servers: readonly BridgeServer[], indexCli?: string): string {
  return [
    'Project-service kickoff for this task:',
    ...(servers.includes('codebase-index')
      ? [
          indexCli !== undefined
            ? `First run ${indexCli} run codebase-context -- --query "<the task>" to locate relevant code.`
            : 'First use mcp__wrongstack-index__codebase_context to locate relevant code.',
        ]
      : []),
    ...(servers.includes('sage')
      ? ['Use mcp__wrongstack-sage__memory_search for prior project guidance.']
      : []),
    ...(servers.includes('mailbox')
      ? ['Check mcp__wrongstack-mailbox__mailbox_read with action "inbox".']
      : []),
    ...(servers.includes('kanban')
      ? ['If the task names a board card, inspect it with mcp__wrongstack-kanban__kanban_read.']
      : []),
    'Then use file and other tools as the task requires.',
  ].join('\n');
}

function serverArgs(server: BridgeServer, projectRoot: string, ctx: SubagentRunContext): string[] {
  const actor = ctx.subagentId;
  const base = ['mcp', 'serve', server, `--project-root=${projectRoot}`];
  switch (server) {
    case 'sage':
      return [...base, `--origin=${actor}`];
    case 'mailbox': {
      const name = ctx.config.name ?? actor;
      return [
        ...base,
        `--actor=${actor}`,
        `--name=${name}`,
        ...(ctx.config.role ? [`--role=${ctx.config.role}`] : []),
        ...(ctx.sessionId ? [`--session-id=${ctx.sessionId}`] : []),
        // Switch last: the global parser would read a following word as its value.
        '--writable',
      ];
    }
    case 'kanban':
      return [...base, `--actor=${actor}`, '--writable'];
    case 'codebase-index':
      // Read-only for the worker, but kept fresh: it edits outside WrongStack.
      return [...base, '--watch'];
    case 'requirement-intake':
      return [...base, '--writable'];
  }
}

/**
 * The note appended to the worker's system prompt. It must not vary per task
 * or per worker: the system prompt is the head of the agent's prompt cache, so
 * a task id or worker id in it made every worker rewrite ~25k cached tokens
 * (measured: $0.21 per one-line task, against $0.008 with a stable prompt).
 * Per-worker identity lives in the MCP servers' arguments instead.
 */
export function bridgeNote(
  servers: readonly BridgeServer[],
  delegated = true,
  indexCli?: string,
): string {
  return [
    'You are working as a delegated worker inside a WrongStack project.',
    'WrongStack is the orchestrator the user runs: it sent you this task and receives your',
    'final reply, so end with a clear summary of what you did and what is left.',
    ...(delegated
      ? [
          'While you work, the WrongStack session can steer you: such a message arrives as a',
          'user message starting with "[WrongStack <kind> from <agent>]". Treat it as coming',
          'from the user who delegated the task, and answer what it asks.',
        ]
      : []),
    '',
    ...serviceNotes(servers, delegated, indexCli),
    '',
    ...serviceWorkflow(servers, indexCli),
    '',
    "WrongStack applies the user's rules to your edits and commands. A refused permission",
    'comes from them (a deny rule the user wrote, a history-rewriting git command, a',
    'credential read): do not retry it or work around it; finish what you can and name what',
    'was refused in your final reply.',
  ].join('\n');
}

/**
 * The note for an agent running as the session's LEADER: the user talks to it
 * through WrongStack, so it answers them directly and ends a turn the way
 * WrongStack's own leader does, with next steps the user can send back.
 */
export function leaderBridgeNote(servers: readonly BridgeServer[], indexCli?: string): string {
  return [
    'You are the leader of a WrongStack session. The user talks to you through WrongStack',
    '(its terminal UI or web UI), which shows your replies, your tool calls and their results.',
    '',
    ...serviceNotes(servers, false, indexCli),
    '',
    ...serviceWorkflow(servers, indexCli),
    '',
    "WrongStack applies the user's rules to your edits and commands and asks the user when one",
    "needs approval. A refused permission is the user's decision or rule: do not retry it or",
    'work around it.',
    '',
    'When you finish a turn and a concrete follow-on action exists, end your reply with a',
    '<nextsteps> block of 1-4 exact prompts the user can send back to you, one per numbered',
    'line, for example:',
    '<nextsteps>',
    '1. Run the package tests and fix any failure',
    '</nextsteps>',
    'When the work is done, end with <nextsteps-complete/> instead.',
  ].join('\n');
}

/** True when `command` resolves to a file on PATH (PATHEXT-aware on Windows). */
export function onPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathVar = env.PATH ?? env.Path ?? '';
  const exts =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, command + ext)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * Bridged agents the leader can hand a task to on this machine: listed in
 * `acp.bridge.agents` (by catalog or registry id) and either configured by
 * the user in `acp.agents` or with their CLI on PATH. Catalog ids, in order.
 */
export function installedBridgeAgents(
  acp: Config['acp'] | undefined,
  isOnPath: (command: string) => boolean = (c) => onPath(c),
): string[] {
  if ((acp?.bridge?.servers ?? DEFAULT_BRIDGE_SERVERS).length === 0) return [];
  const toCatalogId = new Map(Object.entries(REGISTRY_ID_ALIASES).map(([c, r]) => [r, c]));
  const out: string[] = [];
  for (const listed of acp?.bridge?.agents ?? DEFAULT_BRIDGE_AGENTS) {
    const id = findAgentDescriptor(listed) ? listed : (toCatalogId.get(listed) ?? listed);
    if (out.includes(id)) continue;
    const probe = findAgentDescriptor(id)?.probe.command;
    if (acp?.agents?.[id] || acp?.agents?.[listed] || (probe && isOnPath(probe))) out.push(id);
  }
  return out;
}

/**
 * The per-session setup for `agentId`, or undefined when the bridge does not
 * apply to it (not listed, turned off, or no servers).
 */
export function wrongstackBridgeSetup(
  agentId: string,
  projectRoot: string,
  config: BridgeConfig | undefined,
  role: 'worker' | 'leader' = 'worker',
): ((task: TaskSpec, ctx: SubagentRunContext) => AcpSessionSetup) | undefined {
  const agents = config?.agents ?? DEFAULT_BRIDGE_AGENTS;
  // `claude-code` is also reachable by its registry id, `claude-acp`, either
  // way round: `installedBridgeAgents` offers a registry-id listing by its
  // catalog id, and that is the id this is then asked about.
  const listed = (a: string) =>
    a === agentId || REGISTRY_ID_ALIASES[a] === agentId || REGISTRY_ID_ALIASES[agentId] === a;
  if (!agents.some(listed)) return undefined;
  const servers = [...new Set(config?.servers ?? DEFAULT_BRIDGE_SERVERS)].filter(
    (s): s is BridgeServer => Object.hasOwn(SERVER_NAMES, s),
  );
  if (servers.length === 0) return undefined;
  // `indexSurface: 'cli'` swaps the index MCP server for `wstack tools`: no
  // schemas loaded up front, and every call catches the index up with the
  // worker's own edits (the MCP server needs `--watch` for that).
  const indexCli =
    config?.indexSurface === 'cli' && servers.includes('codebase-index')
      ? wstackToolsCommand()
      : undefined;
  const attached = indexCli ? servers.filter((s) => s !== 'codebase-index') : servers;
  return (_task, ctx) => ({
    promptPrefix: bridgeTaskKickoff(servers, indexCli),
    mcpServers: attached.map((server): StdioServer => {
      const launch = wstackLaunch(serverArgs(server, projectRoot, ctx));
      return { name: SERVER_NAMES[server], ...launch, env: [] };
    }),
    meta: {
      systemPrompt: {
        // `@session` only reaches someone when a WrongStack session delegated the task.
        append:
          role === 'leader'
            ? leaderBridgeNote(servers, indexCli)
            : bridgeNote(servers, ctx.sessionId !== undefined, indexCli),
      },
    },
  });
}
