/**
 * Self-update for the standalone executable (scripts/build-binaries.mjs).
 *
 * The npm install updates through a package manager; the binary has none, so
 * it reads the latest GitHub release, downloads the asset built for its own
 * target, verifies it (the release's SHA256SUMS, GitHub's own digest of the
 * asset, and the build attestation: release-attestation.ts) and swaps the
 * running executable in place.
 *
 * The swap never leaves the path empty: POSIX renames the new file over the
 * old one (a running process keeps its inode). Windows cannot overwrite a
 * running .exe but can rename it, so the old file moves aside to `.old` first
 * and is deleted by the next start (scripts/binary/entry.mjs).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FetchError } from '@wrongstack/contracts/types';
import { downloadReleaseAsset } from './release-asset-download.js';
import { RELEASES_REPO, verifyReleaseAttestation } from './release-attestation.js';
import type { TerminalRenderer } from './renderer.js';
import { STANDALONE_TARGET } from './version.js';

const API_LATEST = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  /** `sha256:<hex>`, computed by GitHub when the asset was uploaded. */
  digest?: string | null | undefined;
}

interface LatestRelease {
  version: string;
  assets: ReleaseAsset[];
}

/** Asset name a build target publishes under (mirrors build-binaries.mjs `outputName`). */
export function standaloneAssetName(target: string): string {
  const name = `wstack-${target.replace(/^bun-/, '')}`;
  return target.startsWith('bun-windows') ? `${name}.exe` : name;
}

async function fetchLatestRelease(timeoutMs: number, signal?: AbortSignal): Promise<LatestRelease> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(API_LATEST, {
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wrongstack-cli' },
  });
  if (!res.ok) {
    throw new FetchError({
      message: `GitHub releases responded ${res.status}`,
      status: res.status,
      context: { op: 'checkForUpdate', registry: 'github-releases', url: API_LATEST },
    });
  }
  const data = (await res.json()) as { tag_name?: unknown; assets?: unknown };
  if (typeof data.tag_name !== 'string') throw new Error('Latest release has no tag');
  const assets = Array.isArray(data.assets)
    ? data.assets.filter(
        (a): a is ReleaseAsset =>
          typeof a?.name === 'string' &&
          typeof a?.browser_download_url === 'string' &&
          (a.digest === undefined || a.digest === null || typeof a.digest === 'string'),
      )
    : [];
  return { version: data.tag_name.replace(/^v/, ''), assets };
}

/** The latest release's executable for `target`, with its SHA256SUMS. */
export interface StandaloneRelease {
  version: string;
  assetName: string;
  asset: ReleaseAsset;
  sums: ReleaseAsset;
}

/** Throws when the latest release has no build for `target`. */
export async function findStandaloneRelease(
  target: string,
  signal?: AbortSignal,
): Promise<StandaloneRelease> {
  const release = await fetchLatestRelease(15_000, signal);
  const assetName = standaloneAssetName(target);
  const asset = release.assets.find((a) => a.name === assetName);
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS');
  if (!asset || !sums) throw new Error(`release v${release.version} has no ${assetName} build`);
  return { version: release.version, assetName, asset, sums };
}

/**
 * Throws unless `sha256` is the release's own build of the asset: listed in
 * its SHA256SUMS, equal to the digest GitHub computed at upload, and vouched
 * for by the release workflow's build attestation.
 */
export async function verifyStandaloneDigest(
  release: StandaloneRelease,
  sha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const sumsText = (
    await downloadReleaseAsset(release.sums.browser_download_url, 30_000, MAX_CHECKSUM_BYTES)
  ).toString('utf8');
  if (parseSha256Sums(sumsText).get(release.assetName) !== sha256) {
    throw new Error('checksum does not match the release SHA256SUMS');
  }
  const digest = release.asset.digest;
  if (typeof digest === 'string' && digest !== `sha256:${sha256}`) {
    throw new Error('checksum does not match the digest GitHub recorded for the asset');
  }
  await verifyReleaseAttestation(
    { assetName: release.assetName, sha256, version: release.version },
    signal,
  );
}

/** Latest released version, for the update check. */
export async function fetchLatestStandaloneVersion(
  timeoutMs = 3000,
  signal?: AbortSignal,
): Promise<string> {
  return (await fetchLatestRelease(timeoutMs, signal)).version;
}

/** `<sha256>  <name>` lines → map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match?.[1] && match[2]) {
      const name = match[2].trim();
      if (sums.has(name)) throw new Error(`Duplicate SHA256SUMS entry: ${name}`);
      sums.set(name, match[1].toLowerCase());
    }
  }
  return sums;
}

/**
 * Replace `target` with `bytes`. Staged next to the target so the final step
 * is a same-filesystem rename.
 */
export function replaceExecutable(
  target: string,
  bytes: Buffer,
  platform = process.platform,
): void {
  // `wx` + a random suffix, not `w` + the pid.
  //
  // The staged name has to be predictable-proof for two reasons that both only
  // bite when the install directory is writable by someone else: plain `w`
  // FOLLOWS a symlink planted at that path (writing the new executable wherever
  // the link points, with this process's privileges), and the `mode` argument
  // is ignored when the file already exists (so a pre-created 0666 file would
  // keep its permissions and stay writable after the rename). `wx` fails on an
  // existing path of any kind, including a symlink, and the random suffix means
  // there is no path to pre-create in the first place.
  const staged = stagingPath(target);
  fs.writeFileSync(staged, bytes, { mode: 0o755, flag: 'wx' });
  swapIntoPlace(target, staged, platform);
}

/**
 * Replace `target` with the file at `source` (a downloaded update), refusing
 * unless the copy that is about to become the executable hashes to `sha256`.
 * Synchronous: it runs from the process `exit` handler.
 */
export function installExecutableFrom(
  target: string,
  source: string,
  sha256: string,
  platform = process.platform,
): void {
  const staged = stagingPath(target);
  // COPYFILE_EXCL: same reason as `wx` above.
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  try {
    // Hash the copy, not the source: it is what gets installed.
    if (sha256File(staged) !== sha256) throw new Error('staged update does not match its digest');
    fs.chmodSync(staged, 0o755);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
  swapIntoPlace(target, staged, platform);
}

function stagingPath(target: string): string {
  return `${target}.new-${randomBytes(9).toString('hex')}`;
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let read = fs.readSync(fd, chunk);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Rename `staged` over `target`; the path is never left empty. */
function swapIntoPlace(target: string, staged: string, platform: NodeJS.Platform): void {
  try {
    if (platform === 'win32') {
      const aside = `${target}.old`;
      fs.rmSync(aside, { force: true });
      fs.renameSync(target, aside);
      try {
        fs.renameSync(staged, target);
      } catch (error) {
        fs.renameSync(aside, target);
        throw error;
      }
    } else {
      fs.renameSync(staged, target);
    }
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

/** A verified download the background updater left waiting (standalone-auto-update.ts). */
export interface StagedStandaloneUpdate {
  version: string;
  file: string;
  sha256: string;
}

/** `wstack update` for the standalone binary. Returns the process exit code. */
export async function updateStandaloneBinary(options: {
  current: string;
  renderer: Pick<TerminalRenderer, 'write'>;
  /** Installed instead of downloading again when it is the latest release. */
  staged?: StagedStandaloneUpdate | undefined;
}): Promise<number> {
  const { renderer } = options;
  if (!STANDALONE_TARGET) {
    renderer.write('Update failed: this executable does not record its build target.\n');
    return 1;
  }
  try {
    const release = await findStandaloneRelease(STANDALONE_TARGET);
    renderer.write(`Updating wrongstack from v${options.current} to v${release.version}...\n`);
    const executable = fs.realpathSync(process.execPath);
    const staged = options.staged;
    if (staged && staged.version === release.version) {
      renderer.write(`Installing the v${staged.version} build already downloaded\n`);
      installExecutableFrom(executable, staged.file, staged.sha256);
    } else {
      renderer.write(`Downloading ${release.assetName}\n`);
      const bytes = await downloadReleaseAsset(
        release.asset.browser_download_url,
        600_000,
        MAX_BINARY_BYTES,
      );
      renderer.write('Verifying the checksum and the build attestation\n');
      await verifyStandaloneDigest(release, createHash('sha256').update(bytes).digest('hex'));
      replaceExecutable(executable, bytes);
    }
    renderer.write(
      `\nUpdated ${path.basename(executable)} to v${release.version}. Restart wrongstack to use it.\n`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permission = /EACCES|EPERM/.test(msg)
      ? '\nThe executable is not writable by this user; rerun with the permissions it was installed with.'
      : '';
    renderer.write(`\nUpdate failed: ${msg}${permission}\n`);
    return 1;
  }
}
