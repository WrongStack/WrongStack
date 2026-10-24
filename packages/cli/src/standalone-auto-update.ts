/**
 * Background self-update of the standalone executable.
 *
 * An interactive session that learns a newer release exists downloads that
 * release's build for its own target into `<wstack home>/updates/`, verifies
 * it the way `wstack update` does (SHA256SUMS, GitHub's asset digest, the
 * build attestation), and records it in `pending.json`. When a session exits,
 * the pending build is swapped in over the executable, so the next start runs
 * it; nothing is replaced under a running session. A session that crashed
 * before exiting leaves the update pending for the next one.
 *
 * Off with `update.autoDownload: false` or `WRONGSTACK_NO_AUTO_UPDATE=1`. The
 * npm install never downloads: its package manager owns the files.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { isStandaloneBinary, wstackGlobalRoot } from '@wrongstack/core/utils';
import { downloadReleaseAssetToFile } from './release-asset-download.js';
import {
  findStandaloneRelease,
  installExecutableFrom,
  MAX_BINARY_BYTES,
  type StagedStandaloneUpdate,
  verifyStandaloneDigest,
} from './standalone-update.js';
import { isNewer, type UpdateInfo } from './update-check.js';
import { CLI_VERSION, STANDALONE_TARGET } from './version.js';

const PENDING_FILE = 'pending.json';
const APPLIED_FILE = 'last-applied.json';
const LOCK_FILE = 'update.lock';
/** A lock whose owner is gone, or this old, belongs to nobody. */
const LOCK_STALE_MS = 45 * 60_000;
/** An unparsable lock younger than this is a holder still writing it. */
const LOCK_TORN_GRACE_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** A verified build waiting to be swapped in. */
export interface PendingUpdate extends StagedStandaloneUpdate {
  /** `bun build --target` it was built for. */
  target: string;
  /** Real path of the executable it replaces. */
  executable: string;
  stagedAt: string;
}

/** Where downloads are staged. */
function updatesDir(root: string = wstackGlobalRoot()): string {
  return path.join(root, 'updates');
}

/** `update.autoDownload` (default on) and the `WRONGSTACK_NO_AUTO_UPDATE` switch. */
export function autoUpdateEnabled(
  config: Config | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const off = env['WRONGSTACK_NO_AUTO_UPDATE'];
  if (off !== undefined && off !== '' && off !== '0') return false;
  return config?.update?.autoDownload !== false;
}

/** The pending update, when `pending.json` is intact and names a file in `dir`. */
function readPendingUpdate(dir: string = updatesDir()): PendingUpdate | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, PENDING_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  const p = raw as Partial<PendingUpdate> | null;
  if (
    !p ||
    typeof p.version !== 'string' ||
    typeof p.file !== 'string' ||
    typeof p.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(p.sha256) ||
    typeof p.target !== 'string' ||
    typeof p.executable !== 'string' ||
    // Only ever install from the staging directory itself.
    path.dirname(path.resolve(p.file)) !== path.resolve(dir) ||
    !fs.existsSync(p.file)
  ) {
    return undefined;
  }
  return {
    version: p.version,
    file: p.file,
    sha256: p.sha256,
    target: p.target,
    executable: p.executable,
    stagedAt: typeof p.stagedAt === 'string' ? p.stagedAt : '',
  };
}

function discardPending(dir: string, pending: PendingUpdate | undefined): void {
  fs.rmSync(path.join(dir, PENDING_FILE), { force: true });
  if (pending) fs.rmSync(pending.file, { force: true });
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the lock in `file` has a live holder; undefined when the file is gone. */
function lockHeld(file: string): boolean | undefined {
  let owner: { pid?: unknown; at?: unknown } | null;
  try {
    owner = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof owner;
  } catch (readErr) {
    const code = (readErr as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    // Unreadable right now (EBUSY/EPERM): someone holds it.
    if (code !== undefined) return true;
    // Unparsable: a holder between its `wx` create and the write, or one
    // that crashed there. Only the latter, after a grace, is abandoned.
    try {
      return Date.now() - fs.statSync(file).mtimeMs < LOCK_TORN_GRACE_MS;
    } catch {
      return undefined;
    }
  }
  return (
    typeof owner?.pid === 'number' &&
    pidAlive(owner.pid) &&
    typeof owner.at === 'number' &&
    Date.now() - owner.at < LOCK_STALE_MS
  );
}

/** One download or swap at a time across every session. Returns a release, or undefined when busy. */
function acquireLock(dir: string): (() => void) | undefined {
  const lock = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stamp = JSON.stringify({
      pid: process.pid,
      at: Date.now(),
      token: randomBytes(9).toString('hex'),
    });
    try {
      fs.writeFileSync(lock, stamp, { flag: 'wx' });
      // Only our own lock: a stale-break may have replaced it meanwhile.
      return () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === stamp) fs.rmSync(lock, { force: true });
        } catch {
          // Gone already.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = lockHeld(lock);
      // Released meanwhile: try the exclusive create again.
      if (held === undefined) continue;
      if (held) return undefined;
      // Break by rename and judge what was captured: another session may have
      // broken the same stale lock and taken its own since the read above, and
      // deleting the path then deleted that live lock (d0faa184d).
      const tombstone = `${lock}.${randomBytes(6).toString('hex')}.stale`;
      try {
        fs.renameSync(lock, tombstone);
      } catch {
        continue;
      }
      if (lockHeld(tombstone)) {
        try {
          fs.linkSync(tombstone, lock);
        } catch {
          // A newer lock took the path; it decides.
        }
        fs.rmSync(tombstone, { force: true });
        return undefined;
      }
      fs.rmSync(tombstone, { force: true });
    }
  }
  return undefined;
}

/** One install of the executable: what it is, and where its updates are staged. */
interface Install {
  /** Real path of the executable. */
  executable: string;
  /** `bun build --target` it was built for. */
  target: string;
  /** Version it runs. */
  current: string;
  dir: string;
}

function applyPending(install: Install, platform?: NodeJS.Platform): string | undefined {
  const { dir, current, executable } = install;
  const pending = readPendingUpdate(dir);
  if (!pending) return undefined;
  if (!isNewer(pending.version, current)) {
    discardPending(dir, pending);
    return undefined;
  }
  // Downloaded for another install of wstack: that one applies it.
  if (pending.executable !== executable) return undefined;
  const release = acquireLock(dir);
  if (!release) return undefined;
  try {
    try {
      installExecutableFrom(executable, pending.file, pending.sha256, platform);
    } catch (err) {
      if (/does not match its digest/.test(String(err))) discardPending(dir, pending);
      throw err;
    }
    discardPending(dir, pending);
    writeJsonAtomic(path.join(dir, APPLIED_FILE), {
      from: current,
      to: pending.version,
      at: new Date().toISOString(),
    });
    return pending.version;
  } finally {
    release();
  }
}

/** The swap a previous session made, reported once. */
export function takeAppliedUpdate(
  dir: string = updatesDir(),
): { from: string; to: string } | undefined {
  const file = path.join(dir, APPLIED_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { from?: unknown; to?: unknown };
    fs.rmSync(file, { force: true });
    if (typeof raw.from === 'string' && typeof raw.to === 'string') {
      return { from: raw.from, to: raw.to };
    }
  } catch {
    // none
  }
  return undefined;
}

async function stageLatest(
  install: Install,
  signal: AbortSignal | undefined,
): Promise<PendingUpdate | undefined> {
  const { dir } = install;
  const release = await findStandaloneRelease(install.target, signal);
  if (!isNewer(release.version, install.current)) return undefined;
  const already = readPendingUpdate(dir);
  // The update directory can be shared by multiple standalone installs. A
  // pending record is owned by its recorded executable; only that install may
  // replace or clear it, matching applyPending() and StandaloneUpdater.clear().
  if (already && already.executable !== install.executable) return undefined;
  if (
    already?.version === release.version &&
    already.target === install.target &&
    already.executable === install.executable
  ) {
    return already;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(dir);
  if (!unlock) return undefined;
  const partial = path.join(dir, `.partial-${randomBytes(9).toString('hex')}`);
  try {
    const sha256 = await downloadReleaseAssetToFile(release.asset.browser_download_url, partial, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_BINARY_BYTES,
      signal,
    });
    await verifyStandaloneDigest(release, sha256, signal);
    const file = path.join(dir, `${release.version}-${release.assetName}`);
    fs.rmSync(file, { force: true });
    fs.renameSync(partial, file);
    const pending: PendingUpdate = {
      version: release.version,
      file,
      sha256,
      target: install.target,
      executable: install.executable,
      stagedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(dir, PENDING_FILE), pending);
    // Older staged builds and abandoned partial downloads.
    for (const name of fs.readdirSync(dir)) {
      const keep = [PENDING_FILE, APPLIED_FILE, LOCK_FILE, path.basename(file)];
      if (!keep.includes(name)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    }
    return pending;
  } finally {
    fs.rmSync(partial, { force: true });
    unlock();
  }
}

/** The updates of one install of the executable. */
export interface StandaloneUpdater {
  /** Its verified build waiting to be swapped in, if any. */
  pending(): PendingUpdate | undefined;
  /**
   * Download, verify and stage the latest release when it is newer. Returns
   * the pending update (possibly one staged earlier), or undefined when there
   * is nothing newer or another session is downloading.
   */
  stage(signal?: AbortSignal): Promise<PendingUpdate | undefined>;
  /**
   * Swap the pending build in over the executable. Synchronous (it runs from
   * the process `exit` handler); returns the installed version, or undefined
   * when there was nothing to install. A pending build that is not newer, or
   * whose file no longer matches its digest, is thrown away.
   */
  apply(platform?: NodeJS.Platform): string | undefined;
  /**
   * Drop the pending build after `wstack update` brought the executable to
   * the latest release: it is either the build just installed or an older one.
   */
  clear(): void;
}

export function standaloneUpdater(install: {
  executable: string;
  target: string;
  current: string;
  dir?: string | undefined;
}): StandaloneUpdater {
  const bound: Install = { ...install, dir: install.dir ?? updatesDir() };
  const pending = () => {
    const found = readPendingUpdate(bound.dir);
    return found?.executable === bound.executable ? found : undefined;
  };
  return {
    pending,
    stage: (signal) => stageLatest(bound, signal),
    apply: (platform) => applyPending(bound, platform),
    clear: () => {
      const found = pending();
      if (found) discardPending(bound.dir, found);
    },
  };
}

/** What an interactive session sees of the background update. */
export interface StandaloneAutoUpdate {
  /** Called once the update is ready (immediately, when it already is). */
  subscribe(listener: (version: string) => void): () => void;
  /** Stop a download in progress. The exit swap stays armed. */
  dispose(): void;
}

/**
 * Start the background update for an interactive session: arm the exit swap,
 * and download the latest release when `updateInfo` says one is newer.
 * Undefined for the npm install or when switched off.
 */
export function startStandaloneAutoUpdate(options: {
  getConfig: () => Config | undefined;
  updateInfo: UpdateInfo | undefined;
  onError?: ((message: string) => void) | undefined;
}): StandaloneAutoUpdate | undefined {
  if (!isStandaloneBinary() || !STANDALONE_TARGET) return undefined;
  if (!autoUpdateEnabled(options.getConfig())) return undefined;
  let updater: StandaloneUpdater;
  try {
    updater = standaloneUpdater({
      executable: fs.realpathSync(process.execPath),
      target: STANDALONE_TARGET,
      current: CLI_VERSION,
    });
  } catch {
    return undefined;
  }

  const listeners = new Set<(version: string) => void>();
  let ready: string | undefined;
  const markReady = (version: string) => {
    ready = version;
    for (const listener of listeners) listener(version);
  };

  process.once('exit', () => {
    // Switched off during the session: leave the build for `wstack update`.
    if (!autoUpdateEnabled(options.getConfig())) return;
    try {
      updater.apply();
    } catch {
      // The swap is retried by the next session's exit.
    }
  });

  const found = updater.pending();
  const pending = found && isNewer(found.version, CLI_VERSION) ? found : undefined;
  const latest = options.updateInfo?.outdated ? options.updateInfo.latest : undefined;
  const controller = new AbortController();
  if (pending && (latest === undefined || !isNewer(latest, pending.version))) {
    ready = pending.version;
  } else if (latest !== undefined) {
    void updater
      .stage(controller.signal)
      .then((staged) => {
        if (staged) markReady(staged.version);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        options.onError?.(err instanceof Error ? err.message : String(err));
      });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (ready) listener(ready);
      return () => listeners.delete(listener);
    },
    dispose() {
      controller.abort();
      listeners.clear();
    },
  };
}
