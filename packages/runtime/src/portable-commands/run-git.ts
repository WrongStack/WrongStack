import { spawn } from 'node:child_process';
import { toErrorMessage } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';

/**
 * Run a `git` subcommand and capture its output.
 *
 * Lives in `services/` rather than beside the `/git` slash command because it
 * is shared infrastructure, not command logic: it has no `SlashCommandContext`
 * and no rendering. The TUI resource menus need the same child process, and a
 * non-command module importing `slash-commands/git.ts` is exactly the boundary
 * the architecture check rejects.
 *
 * Never rejects on a non-zero exit — the caller inspects `code`. It rejects
 * only when git could not be spawned at all, or when the 30s timeout fires.
 */
/**
 * Subcommands that only read run isolated from the programs the repository's
 * own config names (fsmonitor, `.gitattributes` filters): a status refresh in
 * a menu must not run them. `add`/`commit`/`push` the user asked for keep
 * git's ordinary behavior, as when they run git themselves.
 */
const READ_COMMANDS: ReadonlySet<string> = new Set(['status', 'diff', 'log', 'show', 'ls-files']);

export async function runGit(
  args: string[],
  cwd: string,
  /** Extra environment (e.g. `GIT_INDEX_FILE`), merged over this process's. */
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const baseEnv = { ...process.env, ...env };
  let isolation: Record<string, string> = {};
  if (READ_COMMANDS.has(args[0] ?? '')) {
    const isolated = await gitIsolationEnv(cwd, { baseEnv });
    if (!isolated) {
      return {
        stdout: '',
        stderr: 'git isolation unavailable: the repository config could not be read',
        code: 1,
      };
    }
    isolation = isolated;
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...baseEnv, ...isolation },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(30_000),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      // Decode across chunks: `+= chunk` decodes each Buffer alone and turns a
      // multibyte UTF-8 character split at a pipe-chunk boundary into U+FFFD.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => {
        reject(new Error(`Failed to run git: ${err.message}`));
      });
      // `code` is null only when git was killed by a signal — never a success.
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}
