/**
 * The operating-system side of `wstack desktop`: reading what is installed and
 * handing a downloaded installer to the OS. Every child here gets the
 * filtered `buildChildEnv()` environment; none of them needs a credential.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { windowsStartCommand } from './desktop-launch.js';
import { DESKTOP_PRODUCT_NAME, type DesktopHost, type DesktopInstall } from './desktop-locate.js';
import type { LinuxPackageFormat } from './desktop-release.js';

/** Tauri's NSIS template records the per-user install under this HKCU key. */
const WINDOWS_UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${DESKTOP_PRODUCT_NAME}`;
const QUERY_TIMEOUT_MS = 10_000;
const VERSION_IN_TEXT = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
/** dpkg-query's `-f=${Version}` (assembled so it does not read as a template placeholder). */
const DPKG_VERSION_FORMAT = `-f=${'$'}{Version}`;

/** `Name    REG_SZ    Value` lines of `reg query` → map (surrounding quotes removed). */
function parseRegQuery(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s+(.+?)\s{2,}REG_[A-Z_]+\s{2,}(.*?)\s*$/);
    if (match?.[1] && match[2] !== undefined) {
      values.set(match[1], match[2].replace(/^"(.*)"$/, '$1'));
    }
  }
  return values;
}

function quietText(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The values the Windows installer recorded (`InstallLocation`, `DisplayVersion`, …). */
export function readWindowsInstallRecord(
  env: NodeJS.ProcessEnv = process.env,
  run: (command: string, args: string[]) => string | undefined = quietText,
): Map<string, string> | undefined {
  const reg = path.win32.join(env['SystemRoot'] || 'C:\\Windows', 'System32', 'reg.exe');
  const output = run(reg, ['query', WINDOWS_UNINSTALL_KEY]);
  return output === undefined ? undefined : parseRegQuery(output);
}

/** `CFBundleShortVersionString` of an XML Info.plist. */
function plistShortVersion(plist: string): string | undefined {
  const match = plist.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/,
  );
  return match?.[1];
}

function versionIn(text: string | undefined): string | undefined {
  return text?.match(VERSION_IN_TEXT)?.[0];
}

/** The first `PATH` directory holding `name`, when any. */
function findOnPath(host: DesktopHost, name: string): string | undefined {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  const dirs = (host.env['PATH'] ?? '').split(host.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    const file = p.join(dir, name);
    if (host.isFile(file)) return file;
  }
  return undefined;
}

/** `deb` on a dpkg system, `rpm` on an rpm one, undefined when neither tool is present. */
export function detectLinuxPackageFormat(host: DesktopHost): LinuxPackageFormat | undefined {
  if (findOnPath(host, 'dpkg')) return 'deb';
  if (findOnPath(host, 'rpm')) return 'rpm';
  return undefined;
}

/**
 * The version of an installed copy, when the platform records one: the
 * Windows uninstall entry, the bundle's Info.plist, or the owning dpkg/rpm
 * package. Portable and override copies record none.
 */
export function readInstalledDesktopVersion(
  install: DesktopInstall,
  host: DesktopHost,
  windowsRecord?: () => Map<string, string> | undefined,
): string | undefined {
  if (install.source !== 'installed') return undefined;
  if (host.platform === 'win32') {
    return versionIn(
      (windowsRecord ?? (() => readWindowsInstallRecord(host.env)))()?.get('DisplayVersion'),
    );
  }
  if (host.platform === 'darwin') {
    if (!install.bundle) return undefined;
    const plist = host.readText(path.posix.join(install.bundle, 'Contents', 'Info.plist'));
    return plist === undefined ? undefined : versionIn(plistShortVersion(plist));
  }
  if (findOnPath(host, 'dpkg-query')) {
    const owner = quietText('dpkg-query', ['-S', install.app])?.split(':')[0]?.trim();
    if (owner) {
      // A Debian revision (`1.5.0-1`) is packaging, not an application prerelease.
      const raw = quietText('dpkg-query', ['-W', DPKG_VERSION_FORMAT, owner]);
      const version = versionIn(raw?.trim().replace(/-\d+$/, ''));
      if (version) return version;
    }
  }
  if (findOnPath(host, 'rpm')) {
    return versionIn(quietText('rpm', ['-qf', '--qf', '%{VERSION}', install.app]));
  }
  return undefined;
}

function exitCode(
  command: string,
  args: string[],
  options: { cwd?: string | undefined; verbatim: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(),
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/** Run the NSIS setup and wait for it; `silent` passes `/S`. Resolves to its exit code. */
export function runWindowsInstaller(setup: string, silent: boolean): Promise<number> {
  const start = windowsStartCommand(setup, {
    wait: true,
    args: silent ? ['/S'] : [],
    comspec: process.env['ComSpec'] || 'cmd.exe',
  });
  return exitCode(start.command, start.args, { cwd: start.cwd, verbatim: true });
}

/** Mount a disk image in Finder. Resolves to `open`'s exit code. */
export function openDiskImage(dmg: string): Promise<number> {
  return exitCode('open', [dmg], { verbatim: false });
}
