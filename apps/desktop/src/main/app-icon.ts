import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nativeImage, type NativeImage } from 'electron';

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
  if (process.platform !== 'darwin') return readIcon('../../assets/icon.svg');
  return (await readIcon('../../assets/icon.png')) ?? readIcon('../../assets/icon.icns');
}
