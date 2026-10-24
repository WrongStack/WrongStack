import type { Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { executeBashStream } from './bash-stream.js';
import type { BashInput, BashOutput } from './bash-types.js';
import { getProcessRegistry } from './process-registry.js';

export type { BashInput, BashOutput } from './bash-types.js';

const MAX_OUTPUT = 32_768;
const MAX_TIMEOUT_MS = 600_000;

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  category: 'Shell',
  description:
    "Execute an arbitrary command in the user's default shell (bash/zsh/pwsh/cmd). " +
    'stdout and stderr are merged into one stream. This is the most powerful and dangerous tool — ' +
    "it gives the model full access to the developer's machine. Prefer specialized tools whenever possible.",
  usageHint:
    'SECURITY WARNING: This tool runs with the full privileges of the current user.\n\n' +
    'Best practices for the model:\n' +
    '- Strongly prefer `exec` for known safe commands (node, npm, pnpm, tsc, git, etc.).\n' +
    '- Use bash only when you genuinely need shell features (pipes, redirection, complex one-liners).\n' +
    '- Prefer single focused commands over huge `&&` chains.\n' +
    '- Use `background: true` only for long-running processes (dev servers, watchers). Its output goes to the `log_file` in the result; `read` it to see how the process is doing.\n' +
    '- `timeout_ms: 0` removes the time limit for a long foreground job you must wait on (the user can still interrupt it).\n' +
    '- `hermetic: true` skips shell startup files and runs with a minimal environment, for reproducible results.\n' +
    '- The working directory is the session working dir (the user changes it with `/working_dir`), defaulting to the project root; use `cd` inside the command for a one-off directory.\n' +
    '- Output may be truncated in the middle for very large results.',
  selection: {
    doNotUseWhen:
      'the command is allowlisted and does not require pipes, redirection, or shell expansion.',
    useInstead: ['exec'],
  },
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'terminal',
  // Trust rules match on the literal `command` string. Without subjectKey
  // the policy heuristic would have done the same here, but declaring it
  // explicitly removes the implicit cross-tool aliasing.
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  // The tool's own timer enforces `timeout_ms` (tree-kill + a structured
  // `timed_out: true` result); the executor only passes the abort signal
  // through. Its generic ceiling (`tools.maxToolTimeoutMs`, 300s by default)
  // used to cut every `timeout_ms` above 5 minutes short and made
  // `timeout_ms: 0` (no limit) impossible.
  managesOwnTimeout: true,
  timeoutMs: MAX_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command to run. Prefer simple, focused commands.',
      },
      timeout_ms: {
        type: 'integer',
        description:
          'Timeout for this command in ms (default 300000, max 600000). 0 = no limit; the user can still interrupt.',
      },
      background: {
        type: 'boolean',
        description:
          'If true, launch the process in the background and return its PID and log_file (its output) immediately.',
      },
      hermetic: {
        type: 'boolean',
        description:
          'If true, skip shell startup files (.bashrc, profile, aliases) and pass only a minimal environment (PATH, HOME, temp, locale).',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: BashOutput | undefined;
    const executeStream = bashTool.executeStream;
    if (!executeStream) throw new Error('bashTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('bash: stream ended without final event');
    return final;
  },
  executeStream: executeBashStream,

  /**
   * Tool-level teardown fired by `ToolExecutor.runToolCleanup()` when the
   * tool's run is aborted/timeout'd. The generator's `finally` block above
   * already force-kills the direct child, but that only runs if the
   * executor closes the async iterator (via `iter.return()`). When the
   * executor tears down without iterating — or a re-entrant abort races
   * with the generator — a bash-spawned process tree can survive in the
   * ProcessRegistry with `killed === false`, continuing to write files,
   * consume CPU, or hold inherited stdio pipes open for the rest of the
   * session.
   *
   * This is the defensive layer the executor calls via `tool.cleanup()`
   * (see `types/tool.ts`): kill every bash-owned process still tracked
   * for this session that hasn't exited yet. `registry.kill()` already
   * handles process-group / taskkill tree-kill and the SIGTERM→SIGKILL
   * grace window, so this just scopes the registry's existing kill path
   * to "this session's runaway bash children". Idempotent — a process
   * that already exited is skipped by `kill()` (it returns false), and a
   * `protected` infrastructure process (dev server the user intentionally
   * backgrounded) is left alone by design.
   */
  async cleanup(_input: BashInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'bash') continue; // leave exec-spawned children alone
      if (entry.child && (entry.child.exitCode != null || entry.child.signalCode != null)) continue; // already reaped
      if (entry.background) continue; // detached jobs intentionally outlive the run/session
      if (entry.protected) continue; // intentionally-backgrounded infra
      registry.kill(entry.pid, { force: true });
    }
  },
};
