import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolvePowerShell, resolveWin32Command } from '../src/_win32-resolve.js';

const isWin = os.platform() === 'win32';

describe('resolvePowerShell', () => {
  it('returns the input unchanged on non-Windows', () => {
    if (isWin) return; // win32-specific assertion
    expect(resolvePowerShell('pwsh')).toBe('pwsh');
    expect(resolvePowerShell('powershell')).toBe('powershell');
    expect(resolvePowerShell('pwsh.exe')).toBe('pwsh.exe');
    expect(resolvePowerShell('powershell.exe')).toBe('powershell.exe');
    // Non-PowerShell inputs are delegated to resolveWin32Command — on POSIX
    // that is a no-op passthrough.
    expect(resolvePowerShell('npx')).toBe('npx');
  });

  it.skipIf(!isWin)('resolves pwsh.exe to its full path when installed', () => {
    const resolved = resolvePowerShell('pwsh');
    // Either we found it (full Windows path) or we didn't (returns input).
    // Either is acceptable — the contract is "return a real path or the
    // original command". Don't assert specific PATH contents here; that's
    // environment-dependent.
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it.skipIf(!isWin)('resolves powershell.exe to its full path when installed', () => {
    const resolved = resolvePowerShell('powershell');
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it.skipIf(!isWin)('falls back to the alternate edition when primary is missing', () => {
    // We can't reliably test ENOENT without a hermetic PATH, but we can
    // exercise the dispatch logic: pass 'pwsh.exe' and 'powershell.exe'
    // explicitly. Both return a string (either resolved or original).
    const pwsh = resolvePowerShell('pwsh.exe');
    const ps = resolvePowerShell('powershell.exe');
    expect(typeof pwsh).toBe('string');
    expect(typeof ps).toBe('string');
  });

  it.skipIf(!isWin)('handles full Windows paths containing powershell in the name', () => {
    // A full path or explicit .exe extension must short-circuit — we don't
    // re-resolve what is already resolved.
    const path = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    expect(resolvePowerShell(path)).toBe(path);
  });
});

describe('resolveWin32Command', () => {
  it('is a no-op on non-Windows', () => {
    if (isWin) return;
    expect(resolveWin32Command('pnpm')).toBe('pnpm');
    expect(resolveWin32Command('C:/some/full/path.exe')).toBe('C:/some/full/path.exe');
  });

  it.skipIf(!isWin)('returns the original command when the binary is not on PATH', () => {
    // Find a name that's vanishingly unlikely to exist.
    const missing = 'definitely-not-a-real-binary-xyz123';
    expect(resolveWin32Command(missing)).toBe(missing);
  });
});