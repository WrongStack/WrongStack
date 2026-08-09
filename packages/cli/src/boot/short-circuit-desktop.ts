/**
 * --desktop short-circuit.
 *
 * Starts the Electron desktop shell before the normal project boot path. This
 * keeps `wstack --desktop` and `wstack desktop` project-independent, matching
 * `--hq`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';

export function stripDesktopLauncherArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--desktop' || arg.startsWith('--desktop=')) continue;
    if (i === 0 && arg === 'desktop') continue;
    out.push(arg);
  }
  return out;
}

export async function handleDesktopShortCircuit(
  flags: Record<string, string | boolean>,
  argv: string[],
): Promise<number | null> {
  if (flags['desktop'] !== true) return null;
  return launchDesktop(stripDesktopLauncherArgs(argv));
}

async function launchDesktop(args: string[]): Promise<number> {
  const req = createRequire(import.meta.url);
  let launcherPath: string;
  try {
    const desktopPkgPath = req.resolve('@wrongstack/desktop/package.json');
    launcherPath = path.join(path.dirname(desktopPkgPath), 'bin', 'wrongstack-desktop.js');
  } catch {
    process.stderr.write(
      [
        color.red('✗ WrongStack Desktop is not installed.'),
        '',
        'Install the desktop package:',
        '  npm install -g @wrongstack/desktop',
        '',
        'The umbrella package also supports desktop when installed with optional dependencies:',
        '  npm install -g wrongstack',
        '',
      ].join('\n'),
    );
    return 1;
  }

  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [launcherPath, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    });
    child.once('error', (err) => {
      process.stderr.write(
        `${color.red('✗ Failed to start WrongStack Desktop:')} ${err.message}\n`,
      );
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else resolve(signal ? 1 : 0);
    });
  });
}
