/**
 * HQ session launcher — opens a NEW headless WrongStack session in this
 * client's project when HQ sends `start-session`.
 *
 * Deliberately narrow, because this is the one place HQ makes a machine start
 * a process:
 *
 * - It only ever launches THIS wstack (its own binary / entry script) — never
 *   a shell, never a command from the wire. The operator's prompt travels as
 *   one argv entry (`--prompt=<text>`), so no character in it is interpreted.
 * - There is no PATH fallback: on Windows that would go through a `.cmd` shim
 *   and cmd.exe, which does interpret characters. No resolvable entry means
 *   the command is refused.
 * - The child runs with `--hq-approver`: its permission prompts wait for an
 *   answer from the HQ Inbox instead of being auto-denied (nobody sits at its
 *   terminal). Everything else — trust rules, the permission mode, the
 *   approval timeout — is this machine's own configuration.
 * - At most {@link HQ_SESSION_LAUNCH_LIMIT} launched sessions run at once per
 *   client process, so a burst of commands cannot fork-bomb the machine.
 *
 * @module hq-session-launcher
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { cliSpawnArgs, isStandaloneBinary } from '@wrongstack/core/utils';

const HQ_SESSION_LAUNCH_LIMIT = 4;

export interface HqSessionLaunch {
  pid: number | undefined;
}

export interface HqSessionLauncher {
  /** Launch one session; throws with a reason the operator can act on. */
  start(prompt: string): HqSessionLaunch;
  /** Launched sessions still running. */
  running(): number;
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => Pick<ChildProcess, 'pid' | 'once' | 'unref'>;

export interface HqSessionLauncherOptions {
  /** The project the new session runs in, read per launch. */
  projectRoot: () => string;
  limit?: number;
  /** Test seams. */
  spawnImpl?: SpawnLike;
  execPath?: string;
  entry?: string | undefined;
  standalone?: boolean;
  platform?: NodeJS.Platform;
}

/** argv (after the executable) for one HQ-started session. */
function hqSessionArgs(entry: string, prompt: string, standalone: boolean): string[] {
  const args = ['--hq-approver', `--prompt=${prompt}`];
  return standalone ? args : cliSpawnArgs(entry, args);
}

export function createHqSessionLauncher(options: HqSessionLauncherOptions): HqSessionLauncher {
  const limit = options.limit ?? HQ_SESSION_LAUNCH_LIMIT;
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const live = new Set<Pick<ChildProcess, 'pid'>>();

  return {
    running: () => live.size,
    start(prompt) {
      if (live.size >= limit) {
        throw new Error(
          `${live.size} sessions started from HQ are still running on this machine (limit ${limit})`,
        );
      }
      const standalone = options.standalone ?? isStandaloneBinary();
      const entry = options.entry ?? process.argv[1];
      if (!standalone && (entry === undefined || !/\.(?:[cm]?js|ts)$/.test(entry))) {
        throw new Error('this client cannot locate its own wstack entry to start a session');
      }
      const isWin = (options.platform ?? process.platform) === 'win32';
      const child = spawnImpl(
        options.execPath ?? process.execPath,
        hqSessionArgs(entry ?? '', prompt, standalone),
        {
          cwd: options.projectRoot(),
          // No terminal: output goes to HQ through the child's own connection.
          stdio: 'ignore',
          // Own process group on POSIX so it outlives this client; on Windows
          // `detached` opens a console window and the child survives anyway.
          detached: !isWin,
          windowsHide: true,
          env: process.env,
          shell: false,
        },
      );
      live.add(child);
      const forget = (): void => {
        live.delete(child);
      };
      child.once('exit', forget);
      child.once('error', forget);
      child.unref();
      return { pid: child.pid };
    },
  };
}
