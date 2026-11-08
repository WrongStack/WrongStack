import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows installer hooks', () => {
  const overlay = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.bundle.conf.json', import.meta.url), 'utf8'),
  );
  it('closes an installed engine still run by an older session host before replacing it', () => {
    // Hosts from 1.5.2 and earlier run the installed engine, and Windows will not replace a
    // running executable. Tauri only checks the main executable, so the hooks check the engine.
    const hooks = readFileSync(
      new URL(`../src-tauri/${overlay.bundle.windows.nsis.installerHooks}`, import.meta.url),
      'utf8',
    );
    for (const hook of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL']) {
      const body = hooks.split(`!macro ${hook}`)[1]?.split('!macroend')[0] ?? '';
      expect(body, hook).toContain('CheckIfAppIsRunning "$INSTDIR\\wrongstack-engine.exe"');
    }
  });
});
