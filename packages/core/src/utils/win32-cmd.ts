/**
 * Safe invocation of Windows `.cmd`/`.bat` shims.
 *
 * Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980), and the
 * obvious workaround — `spawn(line, { shell: true })` — hands the whole command
 * line to `cmd.exe`, where `&`, `|`, `<`, `>` and newlines separate commands. An
 * argument like `--flag=x&calc.exe` then runs a second program.
 *
 * This builds an explicit `cmd.exe /d /c call "<command>" "<arg>" …`
 * invocation with `windowsVerbatimArguments`, so Node passes the line through
 * untouched and every token stays quoted. Metacharacters are refused outright
 * rather than escaped: inside `cmd.exe` double quotes, `%VAR%` still expands and
 * caret escaping does not apply, so quoting alone is not a complete defence.
 *
 * This module is the single source for that construction. `@wrongstack/acp` and
 * `@wrongstack/cli` re-export it; `@wrongstack/mcp` uses it directly for stdio
 * MCP servers, whose `command`/`args` come from user or WebUI-supplied config.
 */

// `%` is here because of the expansion note above: an argument of `%X%` passes a
// metacharacter check that omits it, and cmd.exe then substitutes the variable's
// value — which may itself contain `"` and `&`, breaking out of the quoting this
// module relies on. Refusing `%` outright is the only complete defence, and real
// Windows paths and flags do not contain it.
const WIN32_CMD_META = /[&|<>"%\r\n\0]/;

export interface Win32CmdShimInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: true;
}

export function buildWin32CmdShimInvocation(
  command: string,
  args: readonly string[] = [],
): Win32CmdShimInvocation {
  assertSafeWin32CmdArgs([command, ...args]);
  const line = ['call', quoteWin32CmdArg(command), ...args.map(quoteWin32CmdArg)].join(' ');
  return {
    command: process.env['COMSPEC'] ?? 'cmd.exe',
    args: ['/d', '/c', line],
    windowsVerbatimArguments: true,
  };
}

function assertSafeWin32CmdArgs(args: readonly unknown[]): void {
  for (const arg of args) {
    if (typeof arg === 'string' && WIN32_CMD_META.test(arg)) {
      throw new Error(
        'win32 cmd shim spawn: argument contains a shell metacharacter ' +
          '(one of & | < > ", or a newline) that could enable command injection ' +
          'through the .cmd/.bat wrapper - refusing to run. Offending argument: ' +
          JSON.stringify(arg),
      );
    }
  }
}

function quoteWin32CmdArg(arg: string): string {
  return `"${arg}"`;
}
