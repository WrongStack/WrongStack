import * as os from 'node:os';
import { color } from '@wrongstack/core/utils';
import { API_VERSION, CLI_VERSION } from '../../version.js';
import type { SubcommandHandler } from '../contracts.js';

export const versionCmd: SubcommandHandler = async (_args, deps) => {
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const runtime = bunVersion ? `bun v${bunVersion}` : `node ${process.version}`;
  deps.renderer.write(
    `WrongStack ${CLI_VERSION} (apiVersion ${API_VERSION}, ${runtime}, ${os.platform()})\n`,
  );
  return 0;
};

/** One `  left  description` row; long left sides wrap the description onto the next line. */
function row(left: string, description: string): string {
  const pad = 31;
  return left.length < pad - 2
    ? `  ${left.padEnd(pad - 2)}${description}`
    : `  ${left}\n${' '.repeat(pad)}${description}`;
}

function section(title: string, rows: ReadonlyArray<readonly [string, string]>): string[] {
  return ['', color.bold(title), ...rows.map(([left, description]) => row(left, description))];
}

/**
 * Global help. Every row here must name something the CLI actually reads —
 * `wstack <command> --help` carries the per-command detail, so this page
 * groups by what the user is trying to do rather than listing everything.
 */
export const helpCmd: SubcommandHandler = async (_args, deps) => {
  const lines = [
    color.bold('WrongStack — usage'),
    '',
    '  wstack [flags] ["<task>"]    With a task: run it and exit. Without: start a session.',
    '  wstack <command> --help      Details for one command',
    ...section('Start', [
      ['wstack', 'Interactive session (REPL or TUI, picked at launch)'],
      ['wstack "<task>"', 'Run one task and exit (also: --prompt "<task>")'],
      ['wstack quick', 'Straight into the TUI with the Quick prompt'],
      ['wstack webui | vibeui', 'Browser UI / focused coding workspace'],
      ['wstack hq', 'HQ command center across projects and machines'],
      ['wstack remote <user@host:/path>', 'Run on a remote machine over SSH; WebUI tunneled here'],
      ['wstack --eternal "<mission>"', 'Eternal-autonomy loop against a goal (Ctrl+C stops)'],
      ['wstack acp [serve]', 'Agent Client Protocol server for editors'],
    ]),
    ...section('Sessions', [
      ['wstack sessions', 'List recent sessions (also: fork, doctor, fleet)'],
      ['wstack resume [<id>]', 'Resume a session (same as -r)'],
      ['wstack rewind [<id>]', 'Rewind a session to an earlier point'],
      ['wstack export <id>', 'Render a session as markdown, JSON or text'],
      ['wstack audit | replay [<id>]', 'Tamper-evident audit log / recorded provider responses'],
      ['wstack chronicle', 'Cross-session timeline and metrics'],
      ['wstack usage', 'Token and cost summary'],
    ]),
    ...section('Setup', [
      ['wstack auth', 'Provider keys: add/edit/remove, list, status, local'],
      ['wstack providers | models', 'Browse providers and models; models add|remove|refresh'],
      ['wstack config', 'Show, edit, back up or restore the active profile config'],
      ['wstack config-export | config-import', 'Move behaviour settings via ./wstack-config.json'],
      ['wstack mcp', 'MCP servers: list, add, remove, serve'],
      ['wstack import-claude-code', 'Import MCP servers from Claude Code (preview; --apply)'],
      [
        'wstack sage connect',
        'SAGE memory in Claude Code, Codex, Cursor, Antigravity (MCP + skill)',
      ],
      ['wstack sage sync', 'Keep project SAGE memory synchronized through HQ'],
      ['wstack plugin', 'Plugins: list, install, enable, disable, remove'],
      ['wstack tools | skills', 'List registered tools / discovered skills'],
      ['wstack tools run <tool>', 'Call a built-in tool from a script or external agent'],
      ['wstack typesafe', 'TypeSafe account: status, login, test'],
      ['wstack update', 'Self-update (--check-only)'],
    ]),
    ...section('Project & diagnostics', [
      ['wstack project | projects', 'Committed project identity / tracked projects'],
      ['wstack permissions explain', 'Why a tool call is allowed, asked or denied'],
      ['wstack doctor | diag', 'Health checks / full diagnostic dump'],
      ['wstack governance status', 'Project-daemon health'],
      ['wstack modeldiag | bench', 'Model capability diagnostics / agentic benchmarks'],
      ['wstack mailbox serve', 'HTTP bridge for external agents'],
      ['wstack version', 'Print version'],
    ]),
    ...section('Session flags', [
      ['-c, --continue', 'Resume the most recent session'],
      ['-r, --resume [<id>]', 'Resume a session (latest when no id)'],
      ['--recover', 'Reopen the last session that never closed (crash, kill)'],
      ['--fork-session', 'With -c/-r/--recover: continue a copy, keep the original'],
      ['--provider <id> --model <id>', 'Provider and model for this run'],
      ['--fallback-model <a,b,...>', 'Models to fall back to when the primary is unavailable'],
      ['--effort <level>', 'Reasoning effort: none|minimal|low|medium|high|xhigh|max'],
      [
        '--system-prompt lite|pro|scout|quick|default',
        'System-prompt variant (CLI default: quick)',
      ],
      ['--host-profile', 'Use the saved profile prompt instead of the CLI Quick default'],
      [
        '--append-system-prompt <text> | --append-system-prompt-file <path>',
        'Add instructions to the host agent prompt for this run',
      ],
      ['--goal "<goal>" | --ask "<q>"', 'Open the TUI with a goal or a question queued'],
    ]),
    ...section('Tools & permissions', [
      ['--yolo | --no-yolo', 'Auto-approve on or off (gated destructive kinds still ask)'],
      ['--yolo-destructive', 'Let YOLO run every destructive kind you may un-gate'],
      ['--yolo-plus', 'YOLO+: never ask for anything (explicit deny rules still refuse)'],
      ['--restricted', 'Untrusted repo: no shell/network/MCP tools, stay in project, no YOLO'],
      ['--safe-mode', 'Troubleshoot: no 3rd-party plugins, hooks, MCP, skills, overrides'],
      ['--only-tools <a,b,...>', 'Expose only these tools (trailing * = prefix: mcp__gh__*)'],
      ['--disallowed-tools <a,b,...>', 'Hide these tools, subagents included'],
      ['--allowed-tools <a,b,...>', 'Run these without a prompt (destructive calls still ask)'],
      ['--mcp-config <file|json>', 'Extra MCP servers for this run (.mcp.json accepted)'],
      ['--strict-mcp-config', 'Start only the --mcp-config servers'],
      ['--no-hooks', 'Skip user and plugin hooks (policy hooks still run)'],
    ]),
    ...section('Scripting (with a task)', [
      ['<stdin>', 'Piped input becomes context: git diff | wstack "review this"'],
      ['--output-json', 'One JSON result line: status, finalText, sessionId, usage'],
      [
        '--output-format text|json|stream-json',
        'stream-json: init, assistant, tool_result, result lines',
      ],
      ['--no-tool-coach', 'No [TOOL COACH] advice folded into turns'],
      ['--include-partial-messages', 'stream-json: add text_delta lines'],
      ['--json-schema <file|json>', 'Answer must be JSON matching the schema (structuredOutput)'],
      ['--max-budget-usd <amount>', 'Stop once spend (leader + subagents) passes the amount'],
      ['', 'Exit: 0 done, 1 failed/limit/budget/schema, 130 aborted, 2 usage'],
    ]),
    ...section('Interfaces', [
      ['--tui | --no-tui', 'Force or disable the TUI'],
      ['--mouse', 'Full mouse mode in the TUI'],
      ['--ascii', 'Plain-ASCII symbols, borders and spinners (no emoji or box drawing)'],
      [
        '--webui [--host <h>] [--port <n>] [--open]',
        'Browser UI (+ --webui-token, --webui-public-url, ...)',
      ],
      ['--vibeui [same browser flags]', 'Focused coding workspace (default port 3476)'],
      [
        '--hq [--host <h>] [--port <n>] [--password <p>] [--tunnel] [--open]',
        'HQ server (+ --hq-allowlist, --hq-public-url)',
      ],
    ]),
    ...section('Startup & tuning', [
      ['--skip', 'Skip every startup prompt; use saved choices'],
      ['--skip-index', 'Skip codebase indexing at startup'],
      ['--no-models-refresh', 'Use the cached model catalog'],
      ['--token-saving-tier <tier>', 'auto|off|minimal|light|medium|aggressive'],
      ['--max-concurrent <n> | --max-spawns <n>', 'Fleet concurrency / lifetime subagent spawns'],
      ['--chimera-auto-fix off|ask|auto', 'How to handle Chimera review findings'],
      ['--cwd <dir>', 'Run as if started in <dir>'],
      ['--verbose | --trace | --log-level <l>', 'Log verbosity'],
      ['--metrics [--metrics-port <n>]', 'Metrics and health; Prometheus endpoint on the port'],
      [
        '--record | --replay <session-id>',
        'Record provider responses / serve them back (test harnesses; a changed prompt misses)',
      ],
    ]),
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
};
