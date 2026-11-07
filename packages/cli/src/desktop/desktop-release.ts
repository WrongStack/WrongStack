/**
 * WrongStack Desktop installers on the GitHub release.
 *
 * Each release `v<version>` attaches one installer per platform
 * (`.github/workflows/desktop.yml`, "Collect installers") and their checksums
 * in `DESKTOP-SHA256SUMS` (`release.yml`). An installer is kept only when its
 * SHA-256 matches that file; a missing entry is a refusal too, so nothing
 * unlisted is ever run.
 */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { downloadReleaseAsset, downloadReleaseAssetToFile } from '../release-asset-download.js';
import { RELEASES_REPO } from '../release-attestation.js';
import { parseSha256Sums } from '../standalone-update.js';

export const DESKTOP_SUMS_ASSET = 'DESKTOP-SHA256SUMS';
const MAX_SUMS_BYTES = 1024 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const SUMS_TIMEOUT_MS = 30_000;
const INSTALLER_TIMEOUT_MS = 30 * 60_000;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type LinuxPackageFormat = 'deb' | 'rpm';

/** `1.5.0` from `1.5.0` or `v1.5.0`; undefined for anything that is not a release version. */
export function normalizeDesktopVersion(raw: string): string | undefined {
  const version = raw.trim().replace(/^v/, '');
  return RELEASE_VERSION.test(version) ? version : undefined;
}

/** The matrix label (`windows-x64`, `macos-arm64`, `linux-x64`, …) or undefined when none is built. */
function desktopPlatformLabel(platform: NodeJS.Platform, arch: string): string | undefined {
  const system =
    platform === 'win32'
      ? 'windows'
      : platform === 'darwin'
        ? 'macos'
        : platform === 'linux'
          ? 'linux'
          : undefined;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : undefined;
  return system && cpu ? `${system}-${cpu}` : undefined;
}

/** The installer asset name for this platform, or undefined when the release builds none. */
export function desktopInstallerName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
  linuxFormat: LinuxPackageFormat = 'deb',
): string | undefined {
  const label = desktopPlatformLabel(platform, arch);
  if (!label) return undefined;
  const base = `wrongstack-desktop-${version}-${label}`;
  if (platform === 'win32') return `${base}-setup.exe`;
  if (platform === 'darwin') return `${base}.dmg`;
  return `${base}.${linuxFormat}`;
}

export function desktopReleasePage(version: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`;
}

function desktopReleaseAssetUrl(version: string, name: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

/** The checksum `DESKTOP-SHA256SUMS` lists for `assetName`; throws when it lists none. */
function expectedDesktopChecksum(sumsText: string, assetName: string): string {
  const expected = parseSha256Sums(sumsText).get(assetName);
  if (!expected) {
    throw new Error(
      `${DESKTOP_SUMS_ASSET} has no entry for ${assetName}; refusing to install an unlisted file.`,
    );
  }
  return expected;
}

/** Throws unless `actual` is the checksum `DESKTOP-SHA256SUMS` lists for `assetName`. */
function assertDesktopChecksum(sumsText: string, assetName: string, actual: string): void {
  const expected = expectedDesktopChecksum(sumsText, assetName);
  if (expected !== actual.toLowerCase()) {
    throw new Error(
      `${assetName} does not match ${DESKTOP_SUMS_ASSET} (expected ${expected}, got ${actual}); ` +
        'the download was discarded.',
    );
  }
}

/** The network edge, replaceable in tests. */
export interface DesktopDownloadIo {
  fetchText(url: string): Promise<string>;
  /** Stream `url` into `file` (created exclusively) and return its SHA-256. */
  downloadToFile(url: string, file: string): Promise<string>;
}

const releaseDownloadIo: DesktopDownloadIo = {
  fetchText: async (url) =>
    (await downloadReleaseAsset(url, SUMS_TIMEOUT_MS, MAX_SUMS_BYTES)).toString('utf8'),
  downloadToFile: (url, file) =>
    downloadReleaseAssetToFile(url, file, {
      timeoutMs: INSTALLER_TIMEOUT_MS,
      maxBytes: MAX_INSTALLER_BYTES,
    }),
};

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /responded 404\b/.test(err.message);
}

export interface DesktopDownloadRequest {
  version: string;
  assetName: string;
  /** Directory the verified installer is kept in. */
  dir: string;
  io?: DesktopDownloadIo | undefined;
}

/**
 * Download and verify one installer; returns its path in `dir`. Nothing is
 * left behind under the final name unless its checksum matched.
 */
export async function downloadDesktopInstaller(request: DesktopDownloadRequest): Promise<string> {
  const { version, assetName, dir } = request;
  const io = request.io ?? releaseDownloadIo;
  const page = desktopReleasePage(version);

  let sums: string;
  try {
    sums = await io.fetchText(desktopReleaseAssetUrl(version, DESKTOP_SUMS_ASSET));
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `Release v${version} does not carry WrongStack Desktop installers (no ${DESKTOP_SUMS_ASSET}). ` +
          `See ${page}`,
      );
    }
    throw err;
  }
  // Refuse before downloading anything large.
  const expected = expectedDesktopChecksum(sums, assetName);

  await fsp.mkdir(dir, { recursive: true });
  const partial = path.join(dir, `.${assetName}.${randomBytes(6).toString('hex')}.part`);
  let actual: string;
  try {
    actual = await io.downloadToFile(desktopReleaseAssetUrl(version, assetName), partial);
  } catch (err) {
    await fsp.rm(partial, { force: true });
    if (isNotFound(err)) {
      throw new Error(`Release v${version} has no ${assetName}. See ${page}`);
    }
    throw err;
  }
  if (actual.toLowerCase() !== expected) {
    await fsp.rm(partial, { force: true });
    assertDesktopChecksum(sums, assetName, actual);
  }
  const target = path.join(dir, assetName);
  await fsp.rm(target, { force: true });
  await fsp.rename(partial, target);
  return target;
}
