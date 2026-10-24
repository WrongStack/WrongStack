/**
 * `wstack tools list | describe | run | batch` — WrongStack's built-in tools as
 * plain CLI calls, for any external agent or script that can run a command.
 *
 * The MCP surface (`wstack mcp serve`) hands a client every schema up front and
 * needs a long-lived process. This one is discovered on demand instead —
 * `list` for names, `describe` for one schema, `run` for one call, `batch` for
 * many calls in one process — and stdout is the result. Both surfaces go
 * through the same `ToolGateway`, so exposure, permissions and project-root
 * containment cannot drift apart.
 *
 * Exit codes are the machine contract:
 *   0 completed · 1 tool failed · 2 usage / invalid input
 *   3 not exposed (withheld, session-bound, unknown) or denied by policy
 *   4 needs an interactive confirmation this surface cannot give
 * A batch exits with the code of its first failing call (0 when all pass).
 */

import type { Tool, ToolSettlement } from '@wrongstack/contracts/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  createToolGateway,
  parseCapabilityGrants,
  resolveGatewayRegistry,
  type ToolGateway,
  withheldReason,
} from '../../tool-gateway.js';
import type { SubcommandDeps } from '../contracts.js';
import {
  parseBatchLines,
  parseInputObject,
  parseSchemaArgs,
  readInputText,
  readStream,
  TOOLS_CLI_MAX_INPUT_BYTES,
  type ToolsCliIo,
  ToolsCliUsageError,
} from './tools-cli-args.js';

const TOOLS_CLI_EXIT = {
  ok: 0,
  toolFailed: 1,
  usage: 2,
  notExposed: 3,
  confirmRequired: 4,
} as const;

export type { ToolsCliIo } from './tools-cli-args.js';

const processIo: ToolsCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    // A bare `--input` at an interactive terminal would wait forever for EOF.
    if (process.stdin.isTTY) {
      throw new ToolsCliUsageError('a bare --input reads from stdin, but stdin is a terminal');
    }
    return readStream(process.stdin, TOOLS_CLI_MAX_INPUT_BYTES);
  },
};

/** One settled call, as `run --json` prints it and `batch` prints per line. */
type CallReport =
  | { ok: boolean; tool: string; settlement: ToolSettlement; durationMs: number; content: string }
  | { ok: false; tool: string; error: string; message: string };

interface CallOutcome {
  code: number;
  report: CallReport;
}

export async function runToolsCli(
  verb: string,
  args: readonly string[],
  deps: SubcommandDeps,
  io: ToolsCliIo = processIo,
): Promise<number> {
  if (verb === 'serve') {
    const { serveToolsCommand } = await import('./tools-serve.js');
    return serveToolsCommand(args, deps, io);
  }
  const flags = deps.flags ?? {};
  const json = flags['json'] === true;
  let allow: string[];
  try {
    allow = parseCapabilityGrants(flags['allow']);
  } catch (err) {
    io.stderr(`${toErrorMessage(err)}\n`);
    return TOOLS_CLI_EXIT.usage;
  }
  const registry = resolveGatewayRegistry(deps.toolRegistry, deps.config);
  const gateway = await createToolGateway({
    registry,
    config: deps.config,
    cwd: deps.cwd,
    projectRoot: deps.projectRoot,
    yolo: flags['yolo'] === true || flags['allow-all'] === true,
    allow,
    whitelist: null,
    oneShot: true,
    onWarning: (message) => io.stderr(`wstack tools: ${message}\n`),
  });
  try {
    if (verb === 'list') return listTools(gateway, json, io);
    if (verb === 'agent-guide') {
      io.stdout(toolsAgentGuide(gateway));
      return TOOLS_CLI_EXIT.ok;
    }
    if (verb === 'batch') return await runBatch(gateway, registry, flags, deps.cwd, io);
    const [name, ...rest] = args;
    if (!name) {
      io.stderr(
        `Usage: wstack tools ${verb} <tool>${verb === 'run' ? ' [--input <json>] [-- --<field> <value> ...]' : ''}\n`,
      );
      return TOOLS_CLI_EXIT.usage;
    }
    if (verb === 'describe') return describeTool(gateway, registry, name, json, io);
    // `--input -`: the top-level parser never takes a dash-led token as a value,
    // so `--input` arrives bare and the `-` lands here as a positional.
    const fieldArgs = flags['input'] === true && rest[0] === '-' ? rest.slice(1) : rest;
    const outcome = await runOne(gateway, registry, name, fieldArgs, flags, deps.cwd, io);
    printRun(outcome, json, io);
    return outcome.code;
  } finally {
    await gateway.close();
  }
}

function listTools(gateway: ToolGateway, json: boolean, io: ToolsCliIo): number {
  if (json) {
    io.stdout(
      `${JSON.stringify({
        mode: gateway.mode,
        capabilities: gateway.capabilities,
        tools: gateway.tools.map((t) => ({
          name: t.name,
          permission: t.permission,
          capabilities: t.capabilities ?? [],
          summary: summaryOf(t),
        })),
      })}\n`,
    );
    return TOOLS_CLI_EXIT.ok;
  }
  const width = Math.max(0, ...gateway.tools.map((t) => t.name.length)) + 2;
  for (const t of gateway.tools) io.stdout(`${t.name.padEnd(width)}${summaryOf(t)}\n`);
  io.stderr(
    `${gateway.tools.length} tool(s) exposed (${modeLabel(gateway)}). ` +
      '`wstack tools describe <tool>` shows the input schema.\n',
  );
  return TOOLS_CLI_EXIT.ok;
}

/** Index tools worth naming up front, with the field an agent passes first. */
const GUIDE_INDEX_TOOLS: ReadonlyArray<readonly [tool: string, fields: string, use: string]> = [
  ['codebase-context', '--query "<task>"', 'files and declarations a task touches'],
  ['codebase-search', '--query <name>', 'where something is defined'],
  ['codebase-incoming-calls', '--symbol <name>', 'who calls it'],
  ['codebase-outgoing-calls', '--symbol <name>', 'what it calls'],
  ['codebase-read-symbol', '--file <path> --symbol <name>', "one symbol's source"],
  ['codebase-skeleton', '--path <file-or-dir>', 'an outline without bodies'],
  ['codebase-impact-analysis', '--symbol <name>', 'what a change affects'],
];

/**
 * `wstack tools agent-guide`: a short Markdown section for an agent's
 * instruction file (AGENTS.md, CLAUDE.md). It names how to discover and call
 * the tools rather than embedding every schema — `describe` fetches one when
 * it is needed — and lists only what this invocation's policy exposes.
 */
function toolsAgentGuide(gateway: ToolGateway): string {
  const exposed = new Set(gateway.tools.map((t) => t.name));
  const index = GUIDE_INDEX_TOOLS.filter(([name]) => exposed.has(name));
  const grant =
    gateway.mode === 'safe'
      ? 'Read-only by default. Writes and commands need an explicit grant, e.g. `--allow fs.write`.'
      : `Exposed with ${gateway.mode === 'yolo' ? '--yolo' : `--allow ${gateway.capabilities.join(',')}`}; pass the same flag on every call.`;
  return [
    '## WrongStack tools',
    '',
    "This is a WrongStack project. WrongStack's built-in tools run from the shell, one call per command:",
    '',
    '```sh',
    'wstack tools list                              # names and one-line summaries',
    "wstack tools describe <tool>                   # a tool's fields (JSON schema)",
    'wstack tools run <tool> -- --<field> <value>   # fields after `--`, typed by the schema',
    "wstack tools run <tool> --input '<json>'       # or --input @call.json, or a bare --input for stdin",
    'wstack tools batch < calls.jsonl               # {"tool":…,"input":…,"id":…} per line, one process',
    '```',
    '',
    ...(index.length > 0
      ? [
          'For code navigation prefer the codebase index over grep/glob and whole-file reads; it is',
          'caught up with the disk on every call:',
          '',
          ...index.map(
            ([name, fields, use]) => `- \`wstack tools run ${name} -- ${fields}\` — ${use}`,
          ),
          '',
        ]
      : []),
    `- ${grant} The user's deny rules always apply; deleting outside the project, history-rewriting git and download-and-run commands are refused.`,
    '- Exit codes: 0 ok · 1 tool failed · 2 bad input · 3 not exposed or denied · 4 needs a confirmation. Add `--json` for a `{ok, settlement, content}` envelope.',
    '',
    `Tools exposed here (${gateway.tools.length}): ${gateway.tools.map((t) => t.name).join(', ')}.`,
    '',
  ].join('\n');
}

function describeTool(
  gateway: ToolGateway,
  registry: ToolRegistry,
  name: string,
  json: boolean,
  io: ToolsCliIo,
): number {
  const tool = gateway.get(name);
  if (!tool) {
    const outcome = notExposed(gateway, registry, name);
    printRun(outcome, json, io);
    return outcome.code;
  }
  const inputSchema = tool.inputSchema ?? { type: 'object' };
  if (json) {
    io.stdout(
      `${JSON.stringify({
        name: tool.name,
        permission: tool.permission,
        capabilities: tool.capabilities ?? [],
        description: tool.description,
        inputSchema,
      })}\n`,
    );
    return TOOLS_CLI_EXIT.ok;
  }
  io.stdout(
    `${tool.name} (${tool.permission})\n\n${tool.description.trim()}\n\n` +
      `Input schema:\n${JSON.stringify(inputSchema, null, 2)}\n\n` +
      `Run: wstack tools run ${tool.name} --input '<json>'   (or --input @file.json, a bare --input for stdin,\n` +
      `     or schema fields after --: wstack tools run ${tool.name} -- --<field> <value>)\n`,
  );
  return TOOLS_CLI_EXIT.ok;
}

async function runOne(
  gateway: ToolGateway,
  registry: ToolRegistry,
  name: string,
  fieldArgs: readonly string[],
  flags: Record<string, string | boolean>,
  cwd: string,
  io: ToolsCliIo,
): Promise<CallOutcome> {
  const tool = gateway.get(name);
  if (!tool) return notExposed(gateway, registry, name);
  let input: Record<string, unknown>;
  try {
    const raw = await readInputText(flags['input'], cwd, () => io.readStdin());
    // Fields after `--` override the same keys from --input.
    input = {
      ...(raw ? parseInputObject(raw.text, raw.source) : {}),
      ...parseSchemaArgs(fieldArgs, tool.inputSchema),
    };
  } catch (err) {
    return failure(name, 'invalid_input', toErrorMessage(err), TOOLS_CLI_EXIT.usage);
  }
  return call(gateway, registry, name, input);
}

async function call(
  gateway: ToolGateway,
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<CallOutcome> {
  const outcome = await gateway.call(name, input);
  if (outcome.kind === 'not_exposed') return notExposed(gateway, registry, name);
  if (outcome.kind === 'confirm_required') {
    return failure(
      name,
      'confirm_required',
      `Tool "${name}" needs an interactive confirmation for this input, which \`wstack tools\` cannot give.`,
      TOOLS_CLI_EXIT.confirmRequired,
    );
  }
  const code = exitCodeFor(outcome.settlement, outcome.isError);
  return {
    code,
    report: {
      ok: code === TOOLS_CLI_EXIT.ok,
      tool: name,
      settlement: outcome.settlement,
      durationMs: outcome.durationMs,
      content: outcome.content,
    },
  };
}

/**
 * `wstack tools batch`: JSONL calls on stdin (or `--input @calls.jsonl`), run
 * in order in ONE process — one boot and one daemon connection instead of one
 * per call. Each result is printed as one JSON line as soon as it settles, with
 * the caller's `id` echoed. A failing call does not stop the batch.
 */
async function runBatch(
  gateway: ToolGateway,
  registry: ToolRegistry,
  flags: Record<string, string | boolean>,
  cwd: string,
  io: ToolsCliIo,
): Promise<number> {
  let entries: ReturnType<typeof parseBatchLines>;
  try {
    const raw = await readInputText(flags['input'] ?? true, cwd, () => io.readStdin());
    entries = parseBatchLines(raw?.text ?? '');
  } catch (err) {
    io.stderr(`${toErrorMessage(err)}\n`);
    return TOOLS_CLI_EXIT.usage;
  }
  let exit: number = TOOLS_CLI_EXIT.ok;
  for (const entry of entries) {
    const outcome =
      'error' in entry
        ? failure('', 'invalid_input', entry.error, TOOLS_CLI_EXIT.usage)
        : await call(gateway, registry, entry.tool, entry.input);
    if (exit === TOOLS_CLI_EXIT.ok) exit = outcome.code;
    const id = entry.id === undefined ? {} : { id: entry.id };
    io.stdout(`${JSON.stringify({ line: entry.line, ...id, ...outcome.report })}\n`);
  }
  return exit;
}

function printRun(outcome: CallOutcome, json: boolean, io: ToolsCliIo): void {
  const { report } = outcome;
  if (json) {
    io.stdout(`${JSON.stringify(report)}\n`);
    return;
  }
  const text = 'content' in report ? report.content : report.message;
  const line = text.endsWith('\n') ? text : `${text}\n`;
  if (outcome.code === TOOLS_CLI_EXIT.ok) io.stdout(line);
  else io.stderr(line);
}

function exitCodeFor(settlement: ToolSettlement, isError: boolean): number {
  switch (settlement) {
    case 'completed':
      return isError ? TOOLS_CLI_EXIT.toolFailed : TOOLS_CLI_EXIT.ok;
    case 'invalid_input':
      return TOOLS_CLI_EXIT.usage;
    case 'unknown_tool':
    case 'denied_by_policy':
    case 'blocked_by_hook':
      return TOOLS_CLI_EXIT.notExposed;
    case 'declined':
      return TOOLS_CLI_EXIT.confirmRequired;
    default:
      return TOOLS_CLI_EXIT.toolFailed;
  }
}

function notExposed(gateway: ToolGateway, registry: ToolRegistry, name: string): CallOutcome {
  return failure(
    name,
    'not_exposed',
    withheldReason(gateway, registry, name),
    TOOLS_CLI_EXIT.notExposed,
  );
}

function failure(tool: string, error: string, message: string, code: number): CallOutcome {
  return { code, report: { ok: false, tool, error, message } };
}

function summaryOf(tool: Tool): string {
  const first = tool.description.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

function modeLabel(gateway: ToolGateway): string {
  if (gateway.mode === 'yolo') return 'yolo: every capability';
  if (gateway.mode === 'granted') return `granted: ${gateway.capabilities.join(', ')}`;
  return 'safe: read-only';
}
