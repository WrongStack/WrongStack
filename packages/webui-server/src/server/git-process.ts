import { execFile } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core/utils';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Run a small read-only git query without blocking the WebUI event loop. */
export function gitStdout(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        // H-8 convention (spawn-convention test): read-only git query —
        // PATH and git config are enough; strip credentials.
        env: buildChildEnv(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  const output = await gitStdout(cwd, ['rev-parse', '--is-inside-work-tree']);
  return output?.trim() === 'true';
}
