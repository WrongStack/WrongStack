/**
 * Post-runTui project-switch spawn — extracted from the TUI branch of execute().
 *
 * After the TUI exits with PROJECT_SWITCH_EXIT_CODE (42), a new wstack
 * process is spawned in the target project directory. This replaces the
 * old behavior of spawning mid-session (which left the TUI running and
 * corrupted the terminal state).
 *
 * Returns the exit code when a spawn happened (0), or `null` when the
 * TUI exited normally and the caller should continue its cleanup path.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';

export const PROJECT_SWITCH_EXIT_CODE = 42;

export interface PendingProjectSwitch {
  root: string;
  name: string;
  resumeSessionId?: string | undefined;
}

interface ProjectSwitchSpawnOptions {
  /** The TUI's exit code. */
  code: number;
  /** The pending switch info set by onProjectSelect / onSwitchToSession. */
  pendingProjectSwitch: PendingProjectSwitch | null;
}

/**
 * If the TUI exited with PROJECT_SWITCH_EXIT_CODE and a pending switch
 * is set, spawn a new wstack in the target project and return 0.
 * Otherwise return null (no spawn happened — caller continues cleanup).
 */
export async function handleProjectSwitchSpawn(
  opts: ProjectSwitchSpawnOptions,
): Promise<number | null> {
  const PROJECT_SWITCH_EXIT_CODE = 42;
  if (opts.code !== PROJECT_SWITCH_EXIT_CODE || !opts.pendingProjectSwitch) {
    return null;
  }

  const { root, name, resumeSessionId } = opts.pendingProjectSwitch;

  // Clear screen before spawning — removes TUI artifacts so the new wstack
  // banner starts fresh. \x1b[2J clears visible screen, \x1b[H homes cursor.
  process.stdout.write('\x1b[2J\x1b[H');

  let cliPath: string;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const pkgDir = path.dirname(pkgPath);
    cliPath = path.join(pkgDir, 'dist', 'index.js');
    await fs.access(cliPath);
  } catch {
    cliPath = process.argv[1] ?? '';
    if (!cliPath) {
      console.error(color.red('Could not locate the CLI entry point.\n'));
      return 1;
    }
  }

  const nodeExe = process.execPath;
  const spawnArgs = [cliPath, '--no-interactive'];
  if (resumeSessionId) spawnArgs.push('--resume', resumeSessionId);
  // No abort signal here: the spawned wstack OUTLIVES this process
  // (we exit right after). A previous AbortSignal.timeout(30_000)
  // on this spawn killed the successor 30 seconds in whenever the
  // parent lingered.
  // Use stdio: 'ignore' + detached so the child truly outlives the parent —
  // stdio: 'inherit' would pipe the child's stdin to the parent's, and when
  // the parent exits the pipes close, crashing a child that is still
  // initializing (module load, provider connect).
  //
  // `windowsHide` was missing here while every sibling long-lived spawn sets
  // it (mailbox-serve.ts, mailbox-bridge-bootstrap.ts, the four daemon
  // clients). See `core/tests/architecture/spawn-convention.test.ts` — the
  // flag pair is the convention, and this was the one site outside it.
  const child = spawn(nodeExe, spawnArgs, {
    cwd: root,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.on('error', (err: Error) => {
    console.error(color.red(`Failed to spawn wstack: ${err.message}`));
  });
  // Drop the parent's handle: we exit immediately after printing, and an
  // un-unref'd child handle keeps the event loop alive past that point.
  child.unref();

  console.log(
    [
      '',
      color.green(`  Switched to ${name}`),
      color.dim(`  Root: ${root}`),
      color.dim('  (current session stays open — Ctrl+C to return)'),
      '',
    ].join('\n'),
  );

  return 0;
}
