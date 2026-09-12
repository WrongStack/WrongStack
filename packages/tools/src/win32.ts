/**
 * Public entry for the Windows subprocess helpers.
 *
 * The implementation lives in the internal `_win32-resolve` module (also used
 * by exec.ts/bash.ts). This barrel exposes just the pieces other packages need
 * to launch `.cmd`/`.bat` shims (npx, pnpm, npm, …) safely on Windows, where a
 * bare `execFile('npx', …)` fails ENOENT because execFile ignores PATHEXT.
 */
export {
  assertSafeWin32ShellArgs,
  buildWin32CmdShimInvocation,
  isWinCmdShim,
  resolvePowerShell,
  resolveWin32Command,
  type Win32CmdShimInvocation,
} from './_win32-resolve.js';
