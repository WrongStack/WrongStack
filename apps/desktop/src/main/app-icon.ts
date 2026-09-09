import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nativeImage, type NativeImage } from 'electron';

/**
 * Icon assets in the order `loadDesktopAppIcon` tries them.
 *
 * PNG first on every platform. Electron's `nativeImage` decodes PNG and JPEG
 * (plus ICNS/ICO/TIFF via NSImage on macOS) and **nothing else** — notably not
 * SVG. `createFromPath` does not throw on an unsupported format; it returns an
 * empty 0x0 image, which the `isEmpty()` check below turns into `undefined`.
 *
 * That is exactly how this module shipped without an icon on any platform:
 * non-darwin asked for `icon.svg` (always empty), and darwin asked for
 * `icon.png` / `icon.icns`, neither of which existed. Measured against real
 * Electron 43, not a mock:
 *   icon.svg -> {isEmpty: true,  size: 0x0}
 *   icon.png -> {isEmpty: false, size: 1024x1024}
 *
 * `icon.svg` stays as the editable source of truth for the artwork and is
 * deliberately NOT in this list — listing it would only re-add a candidate
 * that can never load.
 */
const ICON_CANDIDATES: readonly string[] = ['../../assets/icon.png', '../../assets/icon.icns'];

async function readIcon(relativePath: string): Promise<NativeImage | undefined> {
  try {
    // fileURLToPath, not URL.pathname: pathname keeps a win32 leading slash
    // (/D:/...) which fs.stat resolves against the current drive, and stays
    // percent-encoded on every platform — the asset could never be found and
    // the icon silently fell back to the default.
    const iconPath = fileURLToPath(new URL(relativePath, import.meta.url));
    await fs.stat(iconPath);
    const icon = nativeImage.createFromPath(iconPath);
    return icon.isEmpty() ? undefined : icon;
  } catch {
    return undefined;
  }
}

/** Resolves the best supported desktop icon without making application boot depend on it. */
export async function loadDesktopAppIcon(): Promise<NativeImage | undefined> {
  for (const candidate of ICON_CANDIDATES) {
    const icon = await readIcon(candidate);
    if (icon) return icon;
  }
  return undefined;
}
