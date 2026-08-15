/**
 * Additional coverage for bash-kill-guard.ts — parseKillCommand branch
 * coverage for taskkill, Stop-Process, kill, and kill-script patterns.
 * Platform-aware: pkill/killall are POSIX-only, wmic patterns vary.
 */
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseKillCommand } from '../src/bash-kill-guard.js';

const isWin = os.platform() === 'win32';

describe('parseKillCommand', () => {
  // ── taskkill (Windows) ─────────────────────────────────────────────────

  it('parses taskkill /PID with /F', () => {
    if (!isWin) return; // taskkill is Windows-only
    const result = parseKillCommand('taskkill /PID 1234 /F');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  it('parses taskkill /IM by image name', () => {
    if (!isWin) return; // taskkill is Windows-only
    const result = parseKillCommand('taskkill /IM node.exe /F');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('node.exe');
  });

  // ── tskill ─────────────────────────────────────────────────────────────

  it('parses tskill with PID', () => {
    if (!isWin) return; // tskill is Windows-only
    const result = parseKillCommand('tskill 5678');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(5678);
  });

  // ── Stop-Process (PowerShell) ──────────────────────────────────────────

  it('parses Stop-Process -Id', () => {
    if (!isWin) return; // Stop-Process is Windows-only
    const result = parseKillCommand('Stop-Process -Id 1234 -Force');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  it('parses Stop-Process -Name with process name', () => {
    if (!isWin) return; // Stop-Process is Windows-only
    const result = parseKillCommand('Stop-Process -Name "chrome" -Force');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('chrome');
  });

  // ── kill (POSIX) ───────────────────────────────────────────────────────

  it('parses kill with PID', () => {
    const result = parseKillCommand('kill 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('TERM');
  });

  it('parses kill with signal flag', () => {
    const result = parseKillCommand('kill -9 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('9');
  });

  it('parses kill -s SIGNAL PID', () => {
    const result = parseKillCommand('kill -s SIGKILL 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('SIGKILL');
  });

  // ── pkill / killall (POSIX only) ───────────────────────────────────────

  it('parses pkill on POSIX', () => {
    if (isWin) return; // pkill is POSIX-only
    const result = parseKillCommand('pkill node');
    expect(result).not.toBeNull();
  });

  it('parses killall on POSIX', () => {
    if (isWin) return; // killall is POSIX-only
    const result = parseKillCommand('killall node');
    expect(result).not.toBeNull();
  });

  // ── kill scripts ───────────────────────────────────────────────────────

  it('parses kill script (.ps1)', () => {
    if (!isWin) return; // .ps1 scripts are Windows-only
    const result = parseKillCommand('kill-process.ps1 -pid 1234');
    expect(result).not.toBeNull();
  });

  it('parses kill script (.sh)', () => {
    const result = parseKillCommand('./kill-server.sh');
    expect(result).not.toBeNull();
  });

  it('parses kill script (.bat)', () => {
    if (!isWin) return; // .bat scripts are Windows-only
    const result = parseKillCommand('terminate-all.bat');
    expect(result).not.toBeNull();
  });

  it('parses kill script (.cmd)', () => {
    if (!isWin) return; // .cmd scripts are Windows-only
    const result = parseKillCommand('stop-services.cmd');
    expect(result).not.toBeNull();
  });

  // ── wmic (Windows) ──────────────────────────────────────────────────

  it('parses wmic process where "name=..." delete', () => {
    if (!isWin) return; // wmic is Windows-only
    const result = parseKillCommand('wmic process where "name=\'node.exe\'" delete');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('node.exe');
  });

  it('parses wmic process where "ProcessId=N" delete (issue #360)', () => {
    if (!isWin) return; // wmic is Windows-only
    const result = parseKillCommand('wmic process where "ProcessId=1234" delete');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('FORCE');
  });

  it('parses unquoted wmic ProcessId form (issue #360)', () => {
    if (!isWin) return; // wmic is Windows-only
    const result = parseKillCommand('wmic process where ProcessId=1234 delete');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // ── non-kill commands ──────────────────────────────────────────────────

  it('returns null for non-kill commands', () => {
    expect(parseKillCommand('ls -la')).toBeNull();
    expect(parseKillCommand('echo hello')).toBeNull();
    expect(parseKillCommand('node app.js')).toBeNull();
    expect(parseKillCommand('npm run build')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseKillCommand('')).toBeNull();
  });

  it('returns null for commands containing kill as substring', () => {
    expect(parseKillCommand('skillful coding')).toBeNull();
    expect(parseKillCommand('npm install kill-package')).toBeNull();
  });
});
