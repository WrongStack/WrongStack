import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Force-kill a child and its descendants. On Windows a stdio server is launched
 * through a `.cmd` shim with `shell: true`, so `child` is the `cmd.exe` wrapper
 * and the real server (npx→node / uvx) is its grandchild — `child.kill('SIGKILL')`
 * signals only the wrapper and orphans the server, which then accumulates across
 * every close / restart / idle-sleep. `taskkill /T /F` tears down the whole tree.
 */
export function forceKillTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    });
    killer.unref();
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}
