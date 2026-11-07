import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DesktopDownloadIo,
  desktopInstallerName,
  downloadDesktopInstaller,
  normalizeDesktopVersion,
} from '../src/desktop/desktop-release.js';

describe('desktop installer asset names', () => {
  it.each([
    ['win32', 'x64', undefined, 'wrongstack-desktop-1.5.0-windows-x64-setup.exe'],
    ['win32', 'arm64', undefined, 'wrongstack-desktop-1.5.0-windows-arm64-setup.exe'],
    ['darwin', 'arm64', undefined, 'wrongstack-desktop-1.5.0-macos-arm64.dmg'],
    ['darwin', 'x64', undefined, 'wrongstack-desktop-1.5.0-macos-x64.dmg'],
    ['linux', 'x64', 'deb', 'wrongstack-desktop-1.5.0-linux-x64.deb'],
    ['linux', 'arm64', 'rpm', 'wrongstack-desktop-1.5.0-linux-arm64.rpm'],
  ] as const)('%s/%s (%s) → %s', (platform, arch, format, expected) => {
    expect(desktopInstallerName('1.5.0', platform, arch, format)).toBe(expected);
  });

  it('builds nothing for unsupported platforms or CPUs', () => {
    expect(desktopInstallerName('1.5.0', 'freebsd', 'x64')).toBeUndefined();
    expect(desktopInstallerName('1.5.0', 'linux', 'ia32')).toBeUndefined();
    expect(desktopInstallerName('1.5.0', 'win32', 'ia32')).toBeUndefined();
  });

  it('accepts release versions only', () => {
    expect(normalizeDesktopVersion('v1.5.0')).toBe('1.5.0');
    expect(normalizeDesktopVersion('1.6.0-beta.1')).toBe('1.6.0-beta.1');
    expect(normalizeDesktopVersion('dev')).toBeUndefined();
    expect(normalizeDesktopVersion('1.5.0/../../x')).toBeUndefined();
  });
});

const ASSET = 'wrongstack-desktop-1.5.0-linux-x64.deb';
const PAYLOAD = Buffer.from('installer bytes');
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

function fakeIo(
  sums: string | Error,
  payload: Buffer | Error = PAYLOAD,
): DesktopDownloadIo & {
  downloads: number;
  urls: string[];
} {
  const io = {
    downloads: 0,
    urls: [] as string[],
    fetchText: async (url: string) => {
      io.urls.push(url);
      if (sums instanceof Error) throw sums;
      return sums;
    },
    downloadToFile: async (url: string, file: string) => {
      io.urls.push(url);
      io.downloads++;
      if (payload instanceof Error) throw payload;
      fs.writeFileSync(file, payload, { flag: 'wx' });
      return createHash('sha256').update(payload).digest('hex');
    },
  };
  return io;
}

describe('checksum verification', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-desktop-dl-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an installer whose checksum DESKTOP-SHA256SUMS lists', async () => {
    const io = fakeIo(`${SHA}  ${ASSET}\n${'0'.repeat(64)}  other.rpm\n`);
    const file = await downloadDesktopInstaller({ version: '1.5.0', assetName: ASSET, dir, io });
    expect(file).toBe(path.join(dir, ASSET));
    expect(fs.readFileSync(file)).toEqual(PAYLOAD);
    expect(fs.readdirSync(dir)).toEqual([ASSET]);
    // Both files come from the v<version> tag of the release repository.
    expect(io.urls).toEqual([
      'https://github.com/WrongStack/WrongStack/releases/download/v1.5.0/DESKTOP-SHA256SUMS',
      `https://github.com/WrongStack/WrongStack/releases/download/v1.5.0/${ASSET}`,
    ]);
  });

  it('refuses and deletes an installer that does not match', async () => {
    const io = fakeIo(`${'f'.repeat(64)}  ${ASSET}\n`);
    await expect(
      downloadDesktopInstaller({ version: '1.5.0', assetName: ASSET, dir, io }),
    ).rejects.toThrow(/does not match DESKTOP-SHA256SUMS/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses before downloading when the installer has no entry', async () => {
    const io = fakeIo(`${SHA}  wrongstack-desktop-1.5.0-linux-x64.rpm\n`);
    await expect(
      downloadDesktopInstaller({ version: '1.5.0', assetName: ASSET, dir, io }),
    ).rejects.toThrow(/no entry for wrongstack-desktop-1\.5\.0-linux-x64\.deb/);
    expect(io.downloads).toBe(0);
  });

  it('explains a release that carries no desktop installers', async () => {
    const io = fakeIo(new Error('download https://x/DESKTOP-SHA256SUMS responded 404'));
    await expect(
      downloadDesktopInstaller({ version: '1.5.0', assetName: ASSET, dir, io }),
    ).rejects.toThrow(/Release v1\.5\.0 does not carry WrongStack Desktop installers/);
  });

  it('explains a missing installer asset and leaves no partial file', async () => {
    const io = fakeIo(`${SHA}  ${ASSET}\n`, new Error('download https://x/y responded 404'));
    await expect(
      downloadDesktopInstaller({ version: '1.5.0', assetName: ASSET, dir, io }),
    ).rejects.toThrow(`Release v1.5.0 has no ${ASSET}`);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
