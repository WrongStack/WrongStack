/**
 * `wstack desktop` — open, install and update WrongStack Desktop.
 *
 * Dispatched from `boot()` before any config is read, like `wstack update`:
 * none of it needs a provider, a profile or the DI container. It reads its own
 * arguments from the raw argv because the global parser treats `--version`
 * as the "print the CLI version" switch.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import { launchDesktop } from '../../desktop/desktop-launch.js';
import {
  DESKTOP_APP_OVERRIDE_ENV,
  type DesktopHost,
  type DesktopInstall,
  type DesktopLocation,
  locateDesktop,
  systemDesktopHost,
} from '../../desktop/desktop-locate.js';
import {
  DESKTOP_SUMS_ASSET,
  type DesktopDownloadRequest,
  desktopInstallerName,
  desktopReleasePage,
  downloadDesktopInstaller,
  type LinuxPackageFormat,
  normalizeDesktopVersion,
} from '../../desktop/desktop-release.js';
import {
  detectLinuxPackageFormat,
  openDiskImage,
  readInstalledDesktopVersion,
  readWindowsInstallRecord,
  runWindowsInstaller,
} from '../../desktop/desktop-system.js';
import type { TerminalRenderer } from '../../renderer.js';
import { isNewer } from '../../update-check.js';
import { CLI_VERSION } from '../../version.js';
import type { SubcommandHandler } from '../contracts.js';

type Output = Pick<TerminalRenderer, 'write'>;
type DesktopAction = 'open' | 'install' | 'update' | 'path' | 'help';

export interface DesktopArgs {
  action: DesktopAction;
  /** Release to install instead of the CLI's own version. */
  version?: string | undefined;
  silent: boolean;
}

/** Everything `wstack desktop` touches outside this module; tests replace it whole. */
export interface DesktopSystem {
  platform: NodeJS.Platform;
  arch: string;
  cliVersion: string;
  /** Where verified installers are kept. */
  downloadDir: string;
  locate(): DesktopLocation;
  installedVersion(install: DesktopInstall): string | undefined;
  launch(install: DesktopInstall): Promise<void>;
  linuxFormat(): LinuxPackageFormat | undefined;
  download(request: DesktopDownloadRequest): Promise<string>;
  runWindowsInstaller(setup: string, silent: boolean): Promise<number>;
  openDiskImage(dmg: string): Promise<number>;
}

const DESKTOP_USAGE = [
  'Usage: wstack desktop [install | update | path] [--version <x>] [--silent]',
  '',
  '  wstack desktop           Open WrongStack Desktop',
  "  wstack desktop install   Download this platform's installer, verify it, install it",
  '  wstack desktop update    Install when the installed copy is older than the release',
  '  wstack desktop path      Print the application and engine paths',
  '',
  'Options (install, update):',
  "  --version <x>   Release to install (default: this CLI's version)",
  '  --silent        Windows: run the installer without its wizard (/S)',
  '',
  `${DESKTOP_APP_OVERRIDE_ENV}=<executable | directory | .app> selects a specific copy.`,
  '',
].join('\n');

const ACTIONS: readonly DesktopAction[] = ['open', 'install', 'update', 'path', 'help'];

/** The arguments after `desktop` in a raw argv. */
export function argsAfterDesktop(argv: readonly string[]): string[] {
  const at = argv.indexOf('desktop');
  return at === -1 ? [] : argv.slice(at + 1);
}

/** Parse `wstack desktop` arguments; a string is a usage error. */
function parseDesktopArgs(args: readonly string[]): DesktopArgs | string {
  let action: DesktopAction | undefined;
  let version: string | undefined;
  let silent = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--help' || arg === '-h') return { action: 'help', silent };
    if (arg === '--silent') {
      silent = true;
      continue;
    }
    const versionFlag = arg.match(/^--(version|release)(?:=(.*))?$/);
    if (versionFlag) {
      const raw = versionFlag[2] ?? args[++i];
      if (raw === undefined || raw.startsWith('-'))
        return `--${versionFlag[1]} needs a release version`;
      version = normalizeDesktopVersion(raw);
      if (!version) return `Not a release version: ${raw}`;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown desktop option: ${arg}`;
    if (action) return `Unexpected argument: ${arg}`;
    if (!ACTIONS.includes(arg as DesktopAction)) return `Unknown desktop command: ${arg}`;
    action = arg as DesktopAction;
  }
  const resolved = action ?? 'open';
  if ((version || silent) && resolved !== 'install' && resolved !== 'update') {
    return '--version and --silent apply to `wstack desktop install` and `update` only';
  }
  return { action: resolved, version, silent };
}

/** Quote `value` for a POSIX shell when it needs it. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function installHint(): string {
  return 'Install it with: wstack desktop install\n';
}

function describeMissingEngine(install: DesktopInstall): string {
  return (
    `WrongStack Desktop at ${install.app} has no engine beside it (${install.engine} is missing).\n` +
    'The application cannot start without it; refusing to open it.\n' +
    'Reinstall with: wstack desktop install\n'
  );
}

function describeNotInstalled(
  location: Extract<DesktopLocation, { status: 'not-installed' }>,
): string {
  return `${location.problem ?? 'WrongStack Desktop is not installed.'}\n${installHint()}`;
}

async function openDesktop(system: DesktopSystem, out: Output): Promise<number> {
  const location = system.locate();
  if (location.status === 'not-installed') {
    out.write(describeNotInstalled(location));
    return 1;
  }
  if (location.status === 'engine-missing') {
    out.write(describeMissingEngine(location.install));
    return 1;
  }
  try {
    await system.launch(location.install);
  } catch (err) {
    out.write(`Could not open ${location.install.app}: ${toErrorMessage(err)}\n`);
    return 1;
  }
  out.write(`Opened WrongStack Desktop (${location.install.bundle ?? location.install.app}).\n`);
  return 0;
}

function printPaths(system: DesktopSystem, out: Output): number {
  const location = system.locate();
  if (location.status === 'not-installed') {
    out.write(describeNotInstalled(location));
    return 1;
  }
  const { install } = location;
  const missing = location.status === 'engine-missing' ? ' (missing)' : '';
  out.write(
    `app:    ${install.app}\nengine: ${install.engine}${missing}\nsource: ${install.source}\n`,
  );
  if (install.bundle) out.write(`bundle: ${install.bundle}\n`);
  if (missing) out.write(describeMissingEngine(install));
  return missing ? 1 : 0;
}

/** For `update`: undefined to go ahead, or the exit code when nothing needs installing. */
function updateDecision(system: DesktopSystem, version: string, out: Output): number | undefined {
  const location = system.locate();
  if (location.status === 'not-installed') {
    out.write(`WrongStack Desktop is not installed; installing v${version}.\n`);
    return undefined;
  }
  if (location.status === 'engine-missing') {
    out.write(`The installed copy has no engine beside it; reinstalling v${version}.\n`);
    return undefined;
  }
  const installed = system.installedVersion(location.install);
  if (installed === undefined) {
    out.write(`Could not read the version of ${location.install.app}; reinstalling v${version}.\n`);
    return undefined;
  }
  if (!isNewer(version, installed)) {
    out.write(`WrongStack Desktop v${installed} is up to date (release v${version}).\n`);
    return 0;
  }
  out.write(`Updating WrongStack Desktop v${installed} to v${version}.\n`);
  return undefined;
}

async function installDesktop(
  system: DesktopSystem,
  parsed: DesktopArgs,
  out: Output,
): Promise<number> {
  const version = parsed.version ?? normalizeDesktopVersion(system.cliVersion);
  if (!version) {
    out.write(
      `This CLI build (${system.cliVersion}) has no release version; pass --version <x>.\n`,
    );
    return 2;
  }
  if (parsed.action === 'update') {
    const done = updateDecision(system, version, out);
    if (done !== undefined) return done;
  }
  const format = system.platform === 'linux' ? system.linuxFormat() : undefined;
  if (system.platform === 'linux' && !format) {
    out.write(
      `Neither dpkg nor rpm was found; download an installer from ${desktopReleasePage(version)}\n`,
    );
    return 1;
  }
  const assetName = desktopInstallerName(version, system.platform, system.arch, format);
  if (!assetName) {
    out.write(`No WrongStack Desktop installer is built for ${system.platform}-${system.arch}.\n`);
    return 1;
  }

  out.write(`Downloading ${assetName}\n`);
  let file: string;
  try {
    file = await system.download({ version, assetName, dir: system.downloadDir });
  } catch (err) {
    out.write(`wstack desktop: ${toErrorMessage(err)}\n`);
    return 1;
  }
  out.write(`Verified against ${DESKTOP_SUMS_ASSET}: ${file}\n`);
  return handOver(system, parsed, file, format, out);
}

async function handOver(
  system: DesktopSystem,
  parsed: DesktopArgs,
  file: string,
  format: LinuxPackageFormat | undefined,
  out: Output,
): Promise<number> {
  if (system.platform === 'win32') {
    out.write(parsed.silent ? 'Installing silently\n' : 'Opening the installer\n');
    const code = await system.runWindowsInstaller(file, parsed.silent).catch((err: unknown) => {
      out.write(`Could not run ${file}: ${toErrorMessage(err)}\n`);
      return -1;
    });
    if (code !== 0) {
      if (code > 0) out.write(`The installer exited with code ${code}.\n`);
      return 1;
    }
    out.write('WrongStack Desktop is installed. Open it with: wstack desktop\n');
    return 0;
  }
  if (system.platform === 'darwin') {
    if (parsed.silent) out.write('--silent applies to the Windows installer only.\n');
    const code = await system.openDiskImage(file).catch(() => -1);
    if (code !== 0) {
      out.write(`Could not open ${file}; open it from Finder.\n`);
      return 1;
    }
    out.write(
      'Drag WrongStack Desktop into Applications in the window that opened, then run: wstack desktop\n',
    );
    return 0;
  }
  // Installing a system package needs root. Print the command; never run sudo.
  const manager = format === 'rpm' ? 'dnf' : 'apt';
  out.write(
    'Installing it needs root, which wstack does not take. Run:\n' +
      `  sudo ${manager} install ${shellQuote(file)}\n` +
      'Then open it with: wstack desktop\n',
  );
  return 0;
}

/** Run `wstack desktop <args>`. */
export async function runDesktopCommand(
  args: readonly string[],
  deps: { renderer: Output; system?: DesktopSystem | undefined },
): Promise<number> {
  const out = deps.renderer;
  const parsed = parseDesktopArgs(args);
  if (typeof parsed === 'string') {
    out.write(`${parsed}\n${DESKTOP_USAGE}`);
    return 2;
  }
  if (parsed.action === 'help') {
    out.write(DESKTOP_USAGE);
    return 0;
  }
  const system = deps.system ?? systemDesktop();
  if (parsed.action === 'open') return openDesktop(system, out);
  if (parsed.action === 'path') return printPaths(system, out);
  return installDesktop(system, parsed, out);
}

/** The real machine. The Windows install record is read at most once. */
function systemDesktop(): DesktopSystem {
  let record: Map<string, string> | undefined | null = null;
  const windowsRecord = (): Map<string, string> | undefined => {
    if (record === null) record = readWindowsInstallRecord();
    return record;
  };
  const host: DesktopHost = systemDesktopHost(
    process.platform === 'win32' ? () => windowsRecord()?.get('InstallLocation') : undefined,
  );
  return {
    platform: process.platform,
    arch: os.arch(),
    cliVersion: CLI_VERSION,
    downloadDir: path.join(wstackGlobalRoot(), 'downloads', 'desktop'),
    locate: () => locateDesktop(host),
    installedVersion: (install) => readInstalledDesktopVersion(install, host, windowsRecord),
    launch: (install) => launchDesktop(install),
    linuxFormat: () => detectLinuxPackageFormat(host),
    download: downloadDesktopInstaller,
    runWindowsInstaller,
    openDiskImage,
  };
}

/**
 * Registry entry. `boot()` dispatches `desktop` itself with the raw argv;
 * this path rebuilds the flags the global parser lifted out of `args`.
 */
export const desktopCmd: SubcommandHandler = async (args, deps) => {
  const flags = deps.flags ?? {};
  const rebuilt = [...args];
  for (const name of ['version', 'release'] as const) {
    if (typeof flags[name] === 'string') rebuilt.push(`--${name}`, flags[name]);
  }
  if (flags['silent'] === true) rebuilt.push('--silent');
  if (flags['help'] === true) rebuilt.push('--help');
  return runDesktopCommand(rebuilt, { renderer: deps.renderer });
};
