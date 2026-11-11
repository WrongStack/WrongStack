import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows installer hooks', () => {
  const overlay = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.bundle.conf.json', import.meta.url), 'utf8'),
  );
  const hooks = readFileSync(
    new URL(`../src-tauri/${overlay.bundle.windows.nsis.installerHooks}`, import.meta.url),
    'utf8',
  );
  const macroBody = (name: string) => hooks.split(`!macro ${name}`)[1]?.split('!macroend')[0] ?? '';

  it('closes an installed engine still run by an older session host before replacing it', () => {
    // Hosts from 1.5.2 and earlier run the installed engine, and Windows will not replace a
    // running executable. Tauri only checks the main executable, so the hooks check the engine.
    const engine = macroBody('WrongStack_CheckEngineReleased');
    expect(engine).toContain('CheckIfAppIsRunning "$INSTDIR\\wrongstack-engine.exe"');
    for (const hook of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL']) {
      expect(macroBody(hook), hook).toContain('!insertmacro WrongStack_CheckEngineReleased');
    }
  });

  it('keeps the macro labels unique across the two hook insertions', () => {
    // NSIS expands macros textually and Tauri's installer script inserts this body twice
    // (the install section and the uninstall section), so a bare label would be defined
    // twice and makensis would refuse to build the installer.
    const body = macroBody('WrongStack_CheckEngineReleased');
    const names = [...body.matchAll(/wrongstack_engine_[A-Za-z0-9_]+(\$\{suffix\})?/g)];
    expect(names.length).toBeGreaterThan(0);
    for (const [, suffix] of names) {
      expect(suffix).toBe('${suffix}');
    }
    // The two insertions must not share a suffix either.
    expect(macroBody('NSIS_HOOK_PREINSTALL')).toMatch(
      /!insertmacro WrongStack_CheckEngineReleased\s+preinstall/,
    );
    expect(macroBody('NSIS_HOOK_PREUNINSTALL')).toMatch(
      /!insertmacro WrongStack_CheckEngineReleased\s+preuninstall/,
    );
  });

  it('probes the installed engine and refuses the install with the reason it failed', () => {
    const engine = macroBody('WrongStack_CheckEngineReleased');
    // The first probe opens the engine exclusively, so a mapped image or an open handle
    // blocks it. The second probe is a read that tolerates a shared reader, so a file that
    // only denies writing is told apart from a file that is still held.
    expect(engine).toContain('kernel32::CreateFileW');
    expect(engine).toContain('i 0x40000000, i 0, p 0, i 3');
    expect(engine).toContain('i 0x80000000, i 1, p 0, i 3');
    // The refusal names the reason it failed instead of reusing a stale $R3 message.
    expect(engine).toContain('IntCmp $8 1');
    expect(engine).toContain('SetErrorLevel 2');
    expect(engine).toContain('Abort "');
    expect(engine).not.toContain('Abort "$R3"');
  });
});
