/**
 * Test helper: express an expected subprocess invocation in
 * platform-independent terms.
 *
 * Plugins that launch a package-manager or CLI binary must adjust the
 * invocation for the host platform before spawning — on Windows,
 * `npx`/`npm`/`pnpm`/`biome`/`tsc` are `.cmd` shims, and `execFile`/`spawn`
 * without a shell ignore `PATHEXT`, so the bare name fails `ENOENT` and the
 * plugin silently no-ops. `resolveExecInvocation` performs that adjustment.
 *
 * Assertions written against the *pre*-adjustment argv therefore encode the
 * Windows bug and fail once it is fixed. Use these helpers to assert the
 * logical invocation instead: they resolve through the very same function
 * the plugin uses, so a test states "the plugin ran `npm audit --json`"
 * and stays true on every platform.
 */
import { resolveExecInvocation } from '../../src/runtime/index.js';

/**
 * The `(cmd, args)` pair a plugin will actually hand to
 * `execFile`/`spawn` for the given logical command on this platform.
 */
export function expectedInvocation(
  command: string,
  args: readonly string[] = [],
): { cmd: string; args: string[] } {
  const resolved = resolveExecInvocation(command, args);
  return { cmd: resolved.cmd, args: resolved.args };
}

/** Just the resolved command — handy for a single-value assertion. */
export function expectedCommand(command: string, args: readonly string[] = []): string {
  return expectedInvocation(command, args).cmd;
}

/** Just the resolved argument vector. */
export function expectedArgs(command: string, args: readonly string[] = []): string[] {
  return expectedInvocation(command, args).args;
}
