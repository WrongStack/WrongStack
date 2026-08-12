import { spawn } from 'node:child_process';
import { toErrorMessage } from '@wrongstack/core/utils';

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
export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(30_000),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => {
        reject(new Error(`Failed to run git: ${err.message}`));
      });
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}
