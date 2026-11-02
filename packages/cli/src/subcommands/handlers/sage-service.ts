/**
 * `wstack sage service` — choose and set up the memory service for SAGE.
 *
 *   wstack sage service status [--json]
 *   wstack sage service install [--release <v>] [--from <dir>] [--stop-daemon] [--json]
 *   wstack sage service use <local|wrongmemory|auto> [--yes] [--json]
 *
 * `local` (the default) keeps SAGE's built-in store. `wrongmemory` routes every
 * memory operation to the WrongMemory service, shared with other coding tools.
 * `auto` uses WrongMemory only while its daemon runs and the project is
 * registered there.
 *
 * `install` downloads the WrongMemory release for this platform, checks both
 * executables against the release's SHA256SUMS (and GitHub's recorded asset
 * digest), then runs WrongMemory's own `install`, which places them in
 * `%LOCALAPPDATA%\WrongMemory\bin`. `--from <dir>` installs from a local build.
 *
 * `use` prints its plan unless `--yes` is given. Switching to `wrongmemory`
 * backs the project store up, hands it to the service (the local SAGE server
 * stops; WrongMemory holds the owner lock) and writes the mode to the active
 * profile config. Switching back to `local` releases the store in WrongMemory
 * (an adopted store stays where it is; a managed one is exported to the
 * project first) and writes the mode.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildChildEnv, toErrorMessage, updateJsonObjectFile } from '@wrongstack/core/utils';
import { backupCurrent } from '../../config-history.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import { downloadReleaseAsset, downloadReleaseAssetToFile } from '../../release-asset-download.js';
import type { SubcommandDeps } from '../contracts.js';

export const WRONGMEMORY_RELEASE_REPO = 'WrongStack/wrongmemory';
const MODES = ['local', 'wrongmemory', 'auto'] as const;
type Mode = (typeof MODES)[number];
const MAX_EXE_BYTES = 256 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null | undefined;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export interface ServiceIo {
  fetchRelease(version: string | undefined): Promise<Release>;
  download(url: string, file: string): Promise<string>;
  downloadText(url: string): Promise<string>;
  run(exe: string, args: string[]): { status: number | null; stdout: string; stderr: string };
}

const defaultIo: ServiceIo = {
  async fetchRelease(version) {
    const url = version
      ? `https://api.github.com/repos/${WRONGMEMORY_RELEASE_REPO}/releases/tags/${version.startsWith('v') ? version : `v${version}`}`
      : `https://api.github.com/repos/${WRONGMEMORY_RELEASE_REPO}/releases/latest`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'wrongstack-cli', Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) {
      throw new Error(
        version
          ? `WrongMemory release ${version} not found`
          : 'no published WrongMemory release yet; build it and use --from <dir>',
      );
    }
    if (!res.ok) throw new Error(`GitHub release lookup responded ${res.status}`);
    return (await res.json()) as Release;
  },
  download: (url, file) =>
    downloadReleaseAssetToFile(url, file, { timeoutMs: 300_000, maxBytes: MAX_EXE_BYTES }),
  downloadText: async (url) =>
    (await downloadReleaseAsset(url, 30_000, MAX_SUMS_BYTES)).toString('utf8'),
  run(exe, args) {
    // Sanitized environment: no provider keys or vault passphrase reach the
    // WrongMemory CLI. Its data root is passed as --data-root instead.
    const r = spawnSync(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: buildChildEnv(),
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
  },
};

/** `<sha256>  <name>` lines → map. */
function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m?.[1] && m[2]) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

type Sage = typeof import('@wrongstack/sage');
type ServiceConfig = NonNullable<NonNullable<SubcommandDeps['config']['Sage']>['service']>;

function serviceOf(deps: SubcommandDeps): ServiceConfig {
  return (deps.config.Sage?.service ?? {}) as ServiceConfig;
}

/** Run WrongMemory's own installer from `exe` and return its JSON report. */
function runInstaller(
  io: ServiceIo,
  exe: string,
  stopDaemon: boolean,
  dataRoot: string | undefined,
): Record<string, unknown> {
  const r = io.run(exe, [
    ...(dataRoot ? ['--data-root', dataRoot] : []),
    'install',
    '--json',
    ...(stopDaemon ? ['--stop-daemon'] : []),
  ]);
  if (r.status === 6) {
    throw new Error(
      'a WrongMemory daemon is running; rerun with --stop-daemon to stop it and replace the binaries',
    );
  }
  if (r.status !== 0) {
    throw new Error(`wrongmemory install exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  }
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return { output: r.stdout.trim() };
  }
}

export async function installWrongMemory(options: {
  version?: string | undefined;
  from?: string | undefined;
  stopDaemon: boolean;
  /** The WrongMemory data root whose daemon `install` checks (default: its own). */
  dataRoot?: string | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
  io?: ServiceIo;
}): Promise<Record<string, unknown>> {
  const io = options.io ?? defaultIo;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`WrongMemory ships for Windows x64 only; this is ${platform}-${arch}`);
  }
  if (options.from) {
    const dir = path.resolve(options.from);
    for (const exe of ['wrongmemory.exe', 'wrongmemoryd.exe']) {
      if (!existsSync(path.join(dir, exe))) throw new Error(`${exe} not found in ${dir}`);
    }
    return {
      source: dir,
      ...runInstaller(io, path.join(dir, 'wrongmemory.exe'), options.stopDaemon, options.dataRoot),
    };
  }
  const release = await io.fetchRelease(options.version);
  const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS');
  if (!sumsAsset) throw new Error(`release ${release.tag_name} has no SHA256SUMS`);
  const sums = parseSums(await io.downloadText(sumsAsset.browser_download_url));
  const stage = await fs.mkdtemp(path.join(tmpdir(), 'wrongmemory-install-'));
  try {
    for (const exe of ['wrongmemory', 'wrongmemoryd']) {
      const name = `${exe}-windows-x64.exe`;
      const asset = release.assets.find((a) => a.name === name);
      if (!asset) throw new Error(`release ${release.tag_name} has no ${name}`);
      const sha = await io.download(asset.browser_download_url, path.join(stage, `${exe}.exe`));
      if (sums.get(name) !== sha) {
        throw new Error(`${name}: checksum does not match the release SHA256SUMS`);
      }
      if (typeof asset.digest === 'string' && asset.digest !== `sha256:${sha}`) {
        throw new Error(`${name}: checksum does not match the digest GitHub recorded`);
      }
    }
    return {
      source: `${WRONGMEMORY_RELEASE_REPO}@${release.tag_name}`,
      ...runInstaller(
        io,
        path.join(stage, 'wrongmemory.exe'),
        options.stopDaemon,
        options.dataRoot,
      ),
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ServiceStatus {
  mode: Mode;
  installed: boolean;
  binary?: {
    daemon: string;
    cli?: string | undefined;
    source: string;
    version?: string | undefined;
  };
  daemon: 'running' | 'stopped';
  project?: import('@wrongstack/sage').WrongMemoryProjectInfo | undefined;
  storeOwnedByWrongMemory: boolean;
  localStore: boolean;
}

async function readStatus(deps: SubcommandDeps, sage: Sage): Promise<ServiceStatus> {
  const service = serviceOf(deps);
  const daemon = sage.findWrongMemoryBinary('daemon', { daemonPath: service.daemonPath });
  const cli = sage.findWrongMemoryBinary('cli', { daemonPath: service.daemonPath });
  const storeDir = path.join(path.resolve(deps.projectRoot), '.wrongstack', 'memories');
  const status: ServiceStatus = {
    mode: sage.resolveSageServiceMode(service),
    installed: Boolean(daemon && cli),
    daemon: 'stopped',
    storeOwnedByWrongMemory: sage.wrongMemoryOwnsStore(storeDir),
    localStore: existsSync(path.join(storeDir, 'sage.db')),
  };
  if (daemon) {
    status.binary = {
      daemon: daemon.path,
      cli: cli?.path,
      source: daemon.source,
      version: sage.readWrongMemoryInstallManifest(path.dirname(daemon.path))?.version,
    };
  }
  const probe = await sage.probeWrongMemoryService({
    projectRoot: deps.projectRoot,
    dataRoot: service.dataRoot,
  });
  status.daemon = probe.running ? 'running' : 'stopped';
  status.project = probe.project;
  return status;
}

async function setMode(deps: SubcommandDeps, mode: Mode): Promise<string> {
  const file = activeProfileConfigPath(deps.paths, deps.config);
  // Same write path as /setmodel: backup in config history, then an atomic update.
  await updateJsonObjectFile(file, async (cfg) => {
    await backupCurrent(undefined, file);
    const sage = (cfg.Sage && typeof cfg.Sage === 'object' ? cfg.Sage : {}) as Record<
      string,
      unknown
    >;
    const service = (
      sage.service && typeof sage.service === 'object' ? sage.service : {}
    ) as Record<string, unknown>;
    sage.service = { ...service, mode };
    cfg.Sage = sage;
    return cfg;
  });
  return file;
}

async function useMode(
  deps: SubcommandDeps,
  sage: Sage,
  mode: Mode,
  apply: boolean,
  io: ServiceIo,
): Promise<{
  applied: boolean;
  steps: string[];
  backup?: string | undefined;
  configFile?: string | undefined;
}> {
  const status = await readStatus(deps, sage);
  const service = serviceOf(deps);
  const storeDir = path.join(path.resolve(deps.projectRoot), '.wrongstack', 'memories');
  const storePath = path.join(storeDir, 'sage.db');
  const steps: string[] = [];
  let backup: string | undefined;
  const result = () => ({ applied: apply, steps, backup });

  if (mode === 'wrongmemory') {
    if (!status.installed || !status.binary?.cli) {
      throw new Error('WrongMemory is not installed; run `wstack sage service install` first');
    }
    const handOff = status.localStore && !status.storeOwnedByWrongMemory;
    if (handOff) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(storeDir, 'backups', `sage-before-wrongmemory-${stamp}.db`);
      steps.push(`back up the project store to ${backup}`);
      steps.push(
        'hand the store to WrongMemory (the local SAGE server stops; WrongMemory holds the owner lock)',
      );
    } else if (status.storeOwnedByWrongMemory) {
      steps.push('the store is already held by WrongMemory');
    } else {
      steps.push('no local store yet: WrongMemory registers the project on first use');
    }
    steps.push('set Sage.service.mode to "wrongmemory" in the active profile config');
    steps.push(
      'the mode applies to every project of this profile: other projects are registered on first use, ' +
        'adopting an existing store without a backup (run this command in a project to back it up first)',
    );
    if (!apply) return result();
    if (handOff && backup) {
      await fs.mkdir(path.dirname(backup), { recursive: true });
      const r = io.run(status.binary.cli, [
        ...((service.dataRoot ?? process.env.WRONGMEMORY_HOME)
          ? ['--data-root', (service.dataRoot ?? process.env.WRONGMEMORY_HOME) as string]
          : []),
        'backup',
        '--store',
        storePath,
        '--output',
        backup,
        '--json',
      ]);
      if (r.status !== 0) throw new Error(`backup failed: ${(r.stderr || r.stdout).trim()}`);
      const report = await sage.handOffSageToWrongMemory({
        projectRoot: deps.projectRoot,
        directory: deps.config.Sage?.storage?.directory,
        service: { ...service, mode: 'wrongmemory' },
        apply: true,
      });
      if (!report.ownerLocked) throw new Error('the handoff finished without the owner lock');
    }
    return { ...result(), configFile: await setMode(deps, mode) };
  }

  if (mode === 'local') {
    const p = status.project;
    if (p && status.daemon === 'running') {
      if (p.storeKind === 'managed') {
        if (status.localStore) {
          throw new Error(
            `the project has a managed WrongMemory store and also a local ${storePath}; move one aside first`,
          );
        }
        steps.push(`export the WrongMemory store to ${storePath} and release it`);
      } else {
        steps.push(
          'release the store in WrongMemory (it stays in place; local SAGE opens it again)',
        );
      }
    } else if (status.storeOwnedByWrongMemory) {
      if (status.daemon === 'running') {
        const marker = path.join(storeDir, sage.WRONGMEMORY_ADOPTION_MARKER_FILE);
        throw new Error(
          `WrongMemory owns the store (${marker}), but the service at this data root does not serve the project; ` +
            'release it from the WrongMemory data root that adopted it, or delete the marker if none does',
        );
      }
      throw new Error(
        'WrongMemory holds the store but its daemon is not reachable; start it (`wrongmemory daemon start`) and retry',
      );
    }
    steps.push('set Sage.service.mode to "local" in the active profile config');
    if (!apply) return result();
    if (p && status.daemon === 'running') {
      await sage.releaseWrongMemoryProject({ project: p, dataRoot: service.dataRoot });
    }
    return { ...result(), configFile: await setMode(deps, mode) };
  }

  steps.push(
    'set Sage.service.mode to "auto": WrongMemory is used only while its daemon runs and this project is registered',
  );
  if (!apply) return result();
  return { ...result(), configFile: await setMode(deps, mode) };
}

export async function runSageServiceCommand(
  args: string[],
  deps: SubcommandDeps,
  io: ServiceIo = defaultIo,
): Promise<number> {
  const out = (line: string) => deps.renderer.write(`${line}\n`);
  const json = args.includes('--json');
  const words = args.filter(
    (a, i) => !a.startsWith('--') && !['--release', '--from'].includes(args[i - 1] ?? ''),
  );
  const action = words[0];
  const sage = await import('@wrongstack/sage');
  try {
    if (!action || action === 'status') {
      const s = await readStatus(deps, sage);
      if (json) {
        out(JSON.stringify(s, null, 2));
      } else {
        out(`mode:      ${s.mode}`);
        out(
          `installed: ${s.binary ? `${s.binary.daemon} (${s.binary.source}${s.binary.version ? `, v${s.binary.version}` : ''})` : 'no (run `wstack sage service install`)'}`,
        );
        out(`daemon:    ${s.daemon}`);
        out(
          `project:   ${s.project ? `${s.project.projectId} (${s.project.storeKind ?? '?'}, ${s.project.admission ?? '?'})` : 'not registered'}`,
        );
        out(
          `store:     ${s.storeOwnedByWrongMemory ? 'held by WrongMemory' : s.localStore ? 'local SAGE' : 'none yet'}`,
        );
      }
      return 0;
    }
    if (action === 'install') {
      const report = await installWrongMemory({
        version: optionValue(args, 'release'),
        from: optionValue(args, 'from'),
        stopDaemon: args.includes('--stop-daemon'),
        dataRoot: serviceOf(deps).dataRoot ?? process.env.WRONGMEMORY_HOME,
        io,
      });
      if (json) out(JSON.stringify(report, null, 2));
      else {
        out(`WrongMemory installed from ${String(report.source)}`);
        if (report.prefix) out(`  into ${String(report.prefix)}`);
        out('  Next: wstack sage service use wrongmemory');
      }
      return 0;
    }
    if (action === 'use') {
      const mode = words[1] as Mode | undefined;
      if (!mode || !MODES.includes(mode)) {
        out(`Usage: wstack sage service use <${MODES.join('|')}> [--yes]`);
        return 2;
      }
      const apply = args.includes('--yes');
      const r = await useMode(deps, sage, mode, apply, io);
      if (json) out(JSON.stringify({ mode, ...r }, null, 2));
      else {
        out(
          apply
            ? `SAGE memory service: ${mode}`
            : `SAGE memory service: plan for ${mode} (rerun with --yes)`,
        );
        for (const step of r.steps) out(`  - ${step}`);
        if (r.configFile) out(`  config: ${r.configFile}`);
        if (apply) out('  Restart running wstack sessions for this project to pick it up.');
      }
      return 0;
    }
    out(
      'Usage: wstack sage service [status|install [--release <v>] [--from <dir>] [--stop-daemon]|use <local|wrongmemory|auto> [--yes]] [--json]',
    );
    return 2;
  } catch (error) {
    out(`wstack sage service: ${toErrorMessage(error)}`);
    return 1;
  }
}
