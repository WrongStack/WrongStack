/**
 * Open WrongStack Desktop and return without waiting for it.
 *
 * The application is a GUI program, so on Windows it is started through
 * `cmd /c start` rather than spawned directly: `windowsHide` (the repo-wide
 * rule for detached children) puts SW_HIDE into the child's STARTUPINFO, and
 * a GUI program's first window honours that and never appears. `start` hands
 * the application to the shell with a normal show state while the hidden
 * `cmd` flashes nothing. `webui-server/src/server/open-browser.ts` opens the
 * browser the same way. macOS opens the `.app` bundle with `open`, which
 * LaunchServices owns; Linux spawns the executable directly.
 *
 * The child inherits the operator's environment (spawn-convention exemption):
 * the application's engine resolves provider credentials from it exactly as a
 * Start-menu or Dock launch would, so a filtered environment would make a CLI
 * launch behave differently from every other way of opening the app.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import type { DesktopInstall } from './desktop-locate.js';

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd?: string | undefined;
  /** Pass `args` to cmd.exe exactly as written (they carry their own quotes). */
  verbatim: boolean;
}

/** cmd.exe expands `%VAR%` even inside quotes, and a path cannot hold a quote. */
const CMD_UNSAFE = /[%"\r\n]/;

/** `cmd /d /c start "" <extra> "<file>" <args>`, verbatim so the quoting is ours. */
export function windowsStartCommand(
  file: string,
  options: {
    wait?: boolean | undefined;
    args?: readonly string[] | undefined;
    comspec?: string;
  } = {},
): LaunchCommand {
  if (CMD_UNSAFE.test(file)) {
    throw new Error(`Cannot start ${file}: the path contains a character cmd.exe would rewrite.`);
  }
  return {
    command: options.comspec ?? 'cmd.exe',
    args: [
      '/d',
      '/c',
      'start',
      '""',
      ...(options.wait ? ['/wait'] : []),
      `"${file}"`,
      ...(options.args ?? []),
    ],
    cwd: path.win32.dirname(file),
    verbatim: true,
  };
}

/** How `install` is opened on `platform`. */
function desktopLaunchCommand(
  install: DesktopInstall,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): LaunchCommand {
  if (platform === 'win32') {
    return windowsStartCommand(install.app, { comspec: env['ComSpec'] || 'cmd.exe' });
  }
  if (platform === 'darwin' && install.bundle) {
    return { command: 'open', args: [install.bundle], verbatim: false };
  }
  return { command: install.app, args: [], cwd: path.posix.dirname(install.app), verbatim: false };
}

/** The operator environment minus the NODE_ENV default this CLI injected for itself. */
function desktopLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (out['WRONGSTACK_NODE_ENV_DEFAULTED'] === '1') {
    delete out['NODE_ENV'];
    delete out['WRONGSTACK_NODE_ENV_DEFAULTED'];
  }
  return out;
}

/** Start the application detached; resolves once it was spawned, rejects when it could not be. */
export async function launchDesktop(
  install: DesktopInstall,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const launch = desktopLaunchCommand(install, platform, env);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: desktopLaunchEnv(env),
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  });
  try {
    await once(child, 'spawn');
  } finally {
    child.unref();
  }
}
