import { execFile } from 'node:child_process';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LINES = 500;

// Dangerous metacharacters that cmd.exe interprets as shell operators.
// On POSIX we use shell:false so these are harmless literals; on Windows
// with shell:true they are interpreted by cmd.exe — reject them.
const WINDOWS_CMD_METACHARACTERS = /[;&|<>^$,(){}[\]!#%'"\\/`]/;

function validateCommand(cmd: string): void {
  if (process.platform !== 'win32') return;
  if (WINDOWS_CMD_METACHARACTERS.test(cmd)) {
    throw new ToolValidationError({
      message:
        `Command contains disallowed metacharacters for Windows: ${cmd.match(WINDOWS_CMD_METACHARACTERS)?.[0] ?? '?'}\n` +
        'The following characters are not allowed: ; & | < > ^ $ , ( ) { } [ ] ! # % \' " \\ / ` * ?',
      field: 'command',
      context: { platform: 'win32', pattern: WINDOWS_CMD_METACHARACTERS.source },
    });
  }
}

function runCommand(
  cmd: string,
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; killed: boolean }> {
  return new Promise((resolve) => {
    // On POSIX: execFile with shell:false passes the command string as a
    // single argv[] element — metacharacters are literal, safe.
    // On Windows: execFile doesn't support shell:false; shell:true uses
    // cmd.exe which interprets metacharacters. We validate the command
    // upfront (validateCommand) to reject dangerous characters before
    // they reach cmd.exe.
    validateCommand(cmd); // defensive — caller also validates
    const opts = {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024, // 2 MB
      windowsHide: true,
      // On POSIX: no shell → command string is a literal argument.
      // On Windows: shell:true → cmd.exe /c "..." handles quoting.
      shell: process.platform === 'win32',
    };
    execFile(cmd, [], opts, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        killed: error?.killed ?? false,
      });
    });
  });
}

function formatOutput(
  cmd: string,
  result: { stdout: string; stderr: string; exitCode: number; killed: boolean },
  elapsed: number,
): string {
  const lines: string[] = [];

  // Header
  const exitLabel = result.killed
    ? color.red('TIMEOUT')
    : result.exitCode === 0
      ? color.green('OK')
      : color.red(`EXIT ${result.exitCode}`);
  lines.push(`${color.cyan('$')} ${color.bold(cmd)}  ${exitLabel}  ${color.dim(`${elapsed}ms`)}`);

  // Output
  const combined = (result.stdout + result.stderr).trimEnd();
  if (combined) {
    const outputLines = combined.split('\n');
    const truncated = outputLines.length > MAX_OUTPUT_LINES;
    const shown = truncated ? outputLines.slice(0, MAX_OUTPUT_LINES) : outputLines;

    lines.push('');
    lines.push(color.dim('──'));
    for (const line of shown) {
      lines.push(line);
    }
    if (truncated) {
      lines.push(
        color.dim(
          `… (truncated, showing first ${MAX_OUTPUT_LINES} of ${outputLines.length} lines)`,
        ),
      );
    }
    lines.push(color.dim('──'));
  } else {
    lines.push(color.dim('(no output)'));
  }

  return lines.join('\n');
}

/**
 * `/dev <shell command>` — execute a shell command from the chat input and
 * display its output. The LLM does NOT see the result — this is a developer
 * convenience shortcut, not a tool invocation.
 */
export function buildDevCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'dev',
    category: 'Run',
    description: 'Run a shell command and see the output (LLM does not see it).',
    argsHint: '<shell command>',
    help: [
      'Usage:',
      '  /dev <shell command>    Run a command from the chat input.',
      '',
      'Examples:',
      '  /dev pnpm release:check',
      '  /dev git diff --stat',
      '  /dev ls -la src/',
      '',
      'The command runs in the current working directory. Output is displayed',
      'in the chat history but is NOT fed to the LLM — use this for your own',
      'eyes only. Timeout: 60s. Max output: 500 lines.',
      '',
      'This is a convenience shortcut — equivalent to switching to a terminal',
      'tab. For commands the LLM should see, use the `exec` tool instead.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const cmd = args.trim();
      if (!cmd) {
        return {
          message: `${color.yellow('Usage:')} /dev <shell command>\n\nExamples:\n  /dev pnpm release:check\n  /dev git diff --stat`,
        };
      }

      // Reject commands with Windows cmd.exe metacharacters before execution.
      validateCommand(cmd);

      const cwd = opts.cwd;
      const startedAt = Date.now();

      opts.renderer.write(color.dim(`$ ${cmd}`));

      const result = await runCommand(cmd, cwd, DEFAULT_TIMEOUT_MS);
      const elapsed = Date.now() - startedAt;

      const display = formatOutput(cmd, result, elapsed);
      return { message: display };
    },
  };
}
