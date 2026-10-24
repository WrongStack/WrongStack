import type { Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { getProcessRegistry } from './process-registry.js';
import { executePwshStream } from './pwsh-stream.js';
import type { PwshInput, PwshOutput } from './pwsh-types.js';

export type { PwshInput, PwshOutput } from './pwsh-types.js';

const MAX_OUTPUT = 32_768;

export const PWSH_TOOL_DESCRIPTION =
  'Execute a PowerShell command (`pwsh -Command`) in a fresh process on Windows and return its stdout/stderr. ' +
  'Stateless per call: pass `workdir` instead of using `cd`.';

export const PWSH_TOOL_USAGE_HINT =
  'Best practices & sandbox protocol for pwsh:\n' +
  '- **Stateless**: No cwd, variables, or functions persist between calls. Use `workdir` to set the directory.\n' +
  '- **Paths & Environs**: Use native Windows paths (`C:\\...`) and read env vars via `$env:NAME`.\n' +
  '- **Exit Codes**: Non-zero exits are reported as `[exit code: N]`. On Windows, a force-killed command settles as exit code 1 (interruption).\n' +
  '- **Background**: Set `run_in_background: true` for long-running processes; the result carries the PID (stop it with `Stop-Process -Id <pid>`) and the `log_file` its output goes to.\n' +
  '- **Not a sandbox**: Commands run in `FullLanguage` mode with your user privileges. A call refused by permission policy is final — do not retry it with extra fields.';

export const pwshTool: Tool<PwshInput, PwshOutput> = {
  name: 'pwsh',
  category: 'Shell',
  description: PWSH_TOOL_DESCRIPTION,
  usageHint: PWSH_TOOL_USAGE_HINT,
  selection: {
    doNotUseWhen:
      'the command is an allowlisted single binary (node, git, pnpm, tsc) needing no shell expansion or pipelines.',
    useInstead: ['exec'],
  },
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'terminal',
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  // The tool's own timer enforces `timeout_ms`; the executor's generic
  // ceiling (`tools.maxToolTimeoutMs`, 300s by default) would cut longer
  // timeouts short and make `timeout_ms: 0` (no limit) impossible.
  managesOwnTimeout: true,
  timeoutMs: 600_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact PowerShell command or script block to run.',
      },
      workdir: {
        type: 'string',
        description:
          'Absolute or project-relative path to the working directory for this command. Defaults to session working directory.',
      },
      timeout_ms: {
        type: 'integer',
        description:
          'Timeout for this command in ms (default 300000, max 600000). 0 = no limit; the user can still interrupt.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'If true, launch the process in the background and return the job ID / PID immediately.',
      },
      background: {
        type: 'boolean',
        description: 'Alias for run_in_background.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: PwshOutput | undefined;
    const executeStream = pwshTool.executeStream;
    if (!executeStream) throw new Error('pwshTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('pwsh: stream ended without final event');
    return final;
  },
  async cleanup(_input: PwshInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'pwsh') continue;
      if (entry.child && (entry.child.exitCode != null || entry.child.signalCode != null)) continue;
      if (entry.background) continue; // detached jobs intentionally outlive the run/session
      if (entry.protected) continue;
      registry.kill(entry.pid, { force: true });
    }
  },
  executeStream: executePwshStream,
};
