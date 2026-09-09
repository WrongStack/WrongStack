/**
 * `loadDesktopAppIcon()` must return an icon Electron can actually decode.
 *
 * The previous version of this test mocked `nativeImage.createFromPath` to
 * return `{isEmpty: () => false}` for anything at all. That proved the URL math
 * and fs.stat were right and could say nothing about whether an icon ever
 * appeared — and it didn't. The only asset in the repo was `icon.svg`, and
 * `nativeImage` decodes PNG/JPEG (plus ICNS/ICO/TIFF on macOS) but not SVG.
 * `createFromPath` does not throw on an unsupported format; it returns an
 * empty 0x0 image, which the `isEmpty()` guard turns into `undefined`. So the
 * desktop app ran with the default Electron icon on every platform while this
 * file stayed green.
 *
 * Measured against real Electron 43 (not a stub):
 *   icon.svg -> {isEmpty: true,  size: 0x0}
 *   icon.png -> {isEmpty: false, size: 1024x1024}
 *
 * `electron` cannot be imported for real under vitest, so the boundary is
 * still mocked — but the mock now mirrors those semantics by sniffing the file
 * header instead of saying yes to everything. Point it at an SVG and it goes
 * empty, exactly as Electron does.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { createFromPathCalls } = vi.hoisted(() => ({ createFromPathCalls: [] as string[] }));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const ICNS_MAGIC = Buffer.from('icns', 'ascii');

function readHeader(file: string): Buffer {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head;
}

/** True for the raster formats Electron's nativeImage can actually decode. */
function isDecodable(file: string): boolean {
  let head: Buffer;
  try {
    head = readHeader(file);
  } catch {
    return false;
  }
  return (
    head.subarray(0, 8).equals(PNG_MAGIC) ||
    head.subarray(0, 3).equals(JPEG_MAGIC) ||
    head.subarray(0, 4).equals(ICNS_MAGIC)
  );
}

vi.mock('electron', () => ({
  nativeImage: {
    // Faithful to the real API: an unsupported format yields an EMPTY image
    // rather than an error. A mock that returns a usable image for every path
    // is what let an undecodable asset ship.
    createFromPath: (p: string) => {
      createFromPathCalls.push(p);
      const ok = isDecodable(p);
      return {
        isEmpty: () => !ok,
        getSize: () => (ok ? { width: 1024, height: 1024 } : { width: 0, height: 0 }),
      };
    },
  },
}));

import { loadDesktopAppIcon } from '../src/main/app-icon.js';

describe('desktop app icon', () => {
  it('ships a raster icon in a format nativeImage can decode', () => {
    const png = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
    expect(fs.existsSync(png), 'apps/desktop/assets/icon.png is missing').toBe(true);
    expect(
      isDecodable(png),
      'icon.png is not a PNG — nativeImage would return an empty image',
    ).toBe(true);
  });

  it('treats an SVG as undecodable, the way Electron does', () => {
    // Pins the assumption this whole module rests on. If Electron ever gains
    // SVG support this test is the thing that should be revisited first.
    const svg = fileURLToPath(new URL('../assets/icon.svg', import.meta.url));
    expect(fs.existsSync(svg)).toBe(true);
    expect(isDecodable(svg)).toBe(false);
  });

  it('uses the canonical WrongStack mark, not a lookalike of its own', () => {
    // The desktop icon used to be an unrelated drawing — an orange rounded
    // square with two abstract shapes — while every other surface shipped the
    // five-block mark. Pinned byte-for-byte against the website's copy so the
    // app icon cannot drift away from the brand again.
    const svg = fileURLToPath(new URL('../assets/icon.svg', import.meta.url));
    const canonical = fileURLToPath(
      new URL('../../../website/public/wrongstack.svg', import.meta.url),
    );
    expect(fs.readFileSync(svg, 'utf8').trim()).toBe(fs.readFileSync(canonical, 'utf8').trim());
  });

  it('resolves a decodable icon and hands its real path to nativeImage', async () => {
    const icon = await loadDesktopAppIcon();

    expect(
      icon,
      'loadDesktopAppIcon returned undefined — no candidate asset resolved. Either the ' +
        'assets are missing, the asset is not a decodable format, or URL.pathname was ' +
        'reintroduced in place of fileURLToPath.',
    ).toBeTruthy();
    expect(icon?.isEmpty()).toBe(false);

    // The URL-resolution regression: fileURLToPath, never URL.pathname —
    // pathname keeps a win32 leading slash (/D:/…) and stays percent-encoded.
    const recorded = createFromPathCalls.at(-1)!;
    expect(
      fs.existsSync(recorded),
      `path passed to createFromPath does not exist: ${recorded}`,
    ).toBe(true);
    expect(recorded).toBe(fileURLToPath(new URL('../assets/icon.png', import.meta.url)));
  });

  it('ships the assets directory in the published package', () => {
    // The loader reads from `assets/`, which was not in the package `files`
    // list — so every npm install had a loader pointing at a directory that
    // was never published.
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { files?: string[] };
    expect(pkg.files ?? []).toContain('assets');
  });
});
