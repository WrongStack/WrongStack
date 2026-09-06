/**
 * Regression: `readIcon()` in src/main/app-icon.ts must resolve its asset via
 * `fileURLToPath`, never `URL.pathname`.
 *
 * `URL.pathname` is not a filesystem path: on win32 it keeps a leading slash
 * (`/D:/…`) that fs.stat resolves against the CURRENT drive, and on every
 * platform it stays percent-encoded (breaking install paths with spaces).
 * Pre-fix, fs.stat threw ENOENT, the catch swallowed it, and the app icon
 * silently never loaded.
 *
 * The Electron `nativeImage` boundary is mocked; the URL math and fs.stat in
 * the production module run for real. Skipped on darwin, where the platform
 * branch probes icon.png/icon.icns assets that do not ship in-repo.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { createFromPathCalls } = vi.hoisted(() => ({ createFromPathCalls: [] as string[] }));

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (p: string) => {
      createFromPathCalls.push(p);
      return { isEmpty: () => false };
    },
  },
}));

import { loadDesktopAppIcon } from '../src/main/app-icon.js';

const maybeIt = process.platform === 'darwin' ? it.skip : it;

describe('loadDesktopAppIcon asset resolution', () => {
  maybeIt('passes an existing on-disk asset path to nativeImage.createFromPath', async () => {
    const icon = await loadDesktopAppIcon();

    expect(
      createFromPathCalls.length,
      'nativeImage.createFromPath was never reached — readIcon() failed fs.stat ' +
        'on the resolved path; URL.pathname was likely reintroduced',
    ).toBeGreaterThan(0);

    const recorded = createFromPathCalls[0]!;
    expect(
      fs.existsSync(recorded),
      `path passed to createFromPath does not exist on disk: ${recorded}`,
    ).toBe(true);

    expect(icon, 'loadDesktopAppIcon returned undefined for a shipped asset').toBeTruthy();

    const expected = fileURLToPath(new URL('../assets/icon.svg', import.meta.url));
    expect(recorded).toBe(expected);
  });
});
