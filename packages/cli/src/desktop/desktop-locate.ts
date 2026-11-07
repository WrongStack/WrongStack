/**
 * Where WrongStack Desktop (apps/desktop-v2) is installed on this machine.
 *
 * The application finds its engine beside its own executable
 * (`apps/desktop-v2/src-tauri/src/desktop.rs`), so a copy is only usable when
 * both files sit in the same directory. A copy whose engine is missing is
 * reported as such, never skipped in favour of another copy: the user asked
 * for that one, and opening something else would hide the broken install.
 *
 * Lookup order: the `WRONGSTACK_DESKTOP_APP` override, the platform's install
 * locations, then the portable copy a repository checkout stages under
 * `apps/desktop-v2/dist-native/`. Everything the lookup reads comes through
 * {@link DesktopHost}, so tests can describe any platform from any platform.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DESKTOP_PRODUCT_NAME = 'WrongStack Desktop';
export const DESKTOP_APP_OVERRIDE_ENV = 'WRONGSTACK_DESKTOP_APP';
const APP_BASENAME = 'wrongstack-desktop-native';
const ENGINE_BASENAME = 'wrongstack-engine';
/** `apps/desktop-v2/scripts/portable.ts` names each portable build this way. */
const PORTABLE_ID = /^[a-f0-9]{12}-[a-f0-9]{12}$/;

/** What the lookup may read. The defaults read the real machine. */
export interface DesktopHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir: string;
  isFile(file: string): boolean;
  isDirectory(dir: string): boolean;
  readText(file: string): string | undefined;
  /** Windows: the directory the NSIS installer recorded, when it recorded one. */
  windowsInstallLocation?(): string | undefined;
}

export type DesktopSource = 'override' | 'installed' | 'portable';

export interface DesktopInstall {
  source: DesktopSource;
  /** The application executable. */
  app: string;
  /** The engine the application starts; must sit beside {@link app}. */
  engine: string;
  /** macOS: the `.app` bundle the executable belongs to. */
  bundle?: string | undefined;
}

export type DesktopLocation =
  | { status: 'found'; install: DesktopInstall }
  /** The application is there but its engine is not: refuse to open it. */
  | { status: 'engine-missing'; install: DesktopInstall }
  | { status: 'not-installed'; searched: string[]; problem?: string | undefined };

interface Candidate {
  source: DesktopSource;
  app: string;
  bundle?: string | undefined;
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `wrongstack-desktop-native[.exe]` for `platform`. */
function desktopAppFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${APP_BASENAME}.exe` : APP_BASENAME;
}

/** `wrongstack-engine[.exe]` for `platform`. */
function desktopEngineFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${ENGINE_BASENAME}.exe` : ENGINE_BASENAME;
}

/** The engine path that must accompany `app`. */
function engineBeside(app: string, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  return p.join(p.dirname(app), desktopEngineFileName(platform));
}

function bundleCandidate(source: DesktopSource, bundle: string): Candidate {
  const p = path.posix;
  return { source, bundle, app: p.join(bundle, 'Contents', 'MacOS', APP_BASENAME) };
}

/** The candidate an explicit `WRONGSTACK_DESKTOP_APP` names: an executable, its directory, or a `.app`. */
function overrideCandidate(host: DesktopHost, raw: string): Candidate {
  const p = pathFor(host.platform);
  const target = p.resolve(host.cwd, raw);
  if (host.platform === 'darwin' && (target.endsWith('.app') || target.endsWith('.app/'))) {
    return bundleCandidate('override', target.replace(/\/$/, ''));
  }
  if (host.isDirectory(target)) {
    return { source: 'override', app: p.join(target, desktopAppFileName(host.platform)) };
  }
  return { source: 'override', app: target };
}

function windowsLocalAppData(host: DesktopHost): string {
  const value = host.env['LOCALAPPDATA'];
  return value && value.length > 0 ? value : path.win32.join(host.homeDir, 'AppData', 'Local');
}

/** Install locations for `host.platform`, most specific first. */
function installedCandidates(host: DesktopHost): Candidate[] {
  const exe = desktopAppFileName(host.platform);
  if (host.platform === 'win32') {
    const w = path.win32;
    const dirs: string[] = [];
    const recorded = host.windowsInstallLocation?.();
    if (recorded) dirs.push(recorded);
    const local = windowsLocalAppData(host);
    // Tauri's per-user NSIS default, then the electron-style Programs folder.
    dirs.push(w.join(local, DESKTOP_PRODUCT_NAME), w.join(local, 'Programs', DESKTOP_PRODUCT_NAME));
    const seen = new Set<string>();
    return dirs
      .filter((dir) => {
        const key = w.resolve(dir).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((dir) => ({ source: 'installed', app: w.join(dir, exe) }));
  }
  if (host.platform === 'darwin') {
    const bundleName = `${DESKTOP_PRODUCT_NAME}.app`;
    return [
      bundleCandidate('installed', path.posix.join('/Applications', bundleName)),
      bundleCandidate('installed', path.posix.join(host.homeDir, 'Applications', bundleName)),
    ];
  }
  // The .deb and .rpm both install the pair into /usr/bin.
  return [{ source: 'installed', app: path.posix.join('/usr/bin', exe) }];
}

/**
 * The newest portable copy of a repository checkout `host.cwd` sits in, when
 * `apps/desktop-v2/dist-native/latest.json` names a well-formed build.
 */
function portableCandidate(host: DesktopHost): Candidate | undefined {
  const p = pathFor(host.platform);
  let dir = p.resolve(host.cwd);
  for (;;) {
    const distNative = p.join(dir, 'apps', 'desktop-v2', 'dist-native');
    const latest = host.readText(p.join(distNative, 'latest.json'));
    if (latest !== undefined) {
      let directory: unknown;
      try {
        directory = (JSON.parse(latest) as { directory?: unknown } | null)?.directory;
      } catch {
        return undefined;
      }
      if (typeof directory !== 'string' || !PORTABLE_ID.test(directory)) return undefined;
      return {
        source: 'portable',
        app: p.join(distNative, directory, desktopAppFileName(host.platform)),
      };
    }
    const parent = p.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function settle(host: DesktopHost, candidate: Candidate): DesktopLocation {
  const install: DesktopInstall = {
    source: candidate.source,
    app: candidate.app,
    engine: engineBeside(candidate.app, host.platform),
    ...(candidate.bundle ? { bundle: candidate.bundle } : {}),
  };
  return host.isFile(install.engine)
    ? { status: 'found', install }
    : { status: 'engine-missing', install };
}

/** Find WrongStack Desktop: the override, then installed copies, then the repository's portable copy. */
export function locateDesktop(host: DesktopHost): DesktopLocation {
  const override = host.env[DESKTOP_APP_OVERRIDE_ENV]?.trim();
  if (override) {
    const candidate = overrideCandidate(host, override);
    if (!host.isFile(candidate.app)) {
      // An explicit choice that is wrong must say so, not fall back to a different copy.
      return {
        status: 'not-installed',
        searched: [candidate.app],
        problem: `${DESKTOP_APP_OVERRIDE_ENV} is set, but ${candidate.app} does not exist.`,
      };
    }
    return settle(host, candidate);
  }
  const candidates = installedCandidates(host);
  const portable = portableCandidate(host);
  if (portable) candidates.push(portable);
  for (const candidate of candidates) {
    if (host.isFile(candidate.app)) return settle(host, candidate);
  }
  return { status: 'not-installed', searched: candidates.map((c) => c.app) };
}

function statKind(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** A {@link DesktopHost} reading this machine. */
export function systemDesktopHost(windowsInstallLocation?: () => string | undefined): DesktopHost {
  return {
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    homeDir: os.homedir(),
    isFile: (file) => statKind(file)?.isFile() === true,
    isDirectory: (dir) => statKind(dir)?.isDirectory() === true,
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    ...(windowsInstallLocation ? { windowsInstallLocation } : {}),
  };
}
