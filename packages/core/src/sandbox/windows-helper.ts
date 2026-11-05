/**
 * Windows restricted-token helper (plan 28, T5.1 prototype + T5.2 propagation).
 *
 * T5.2 replaces the detached `runas /trustlevel` prototype as the primary
 * helper with a **runtime-compiled .NET P/Invoke host**: PowerShell's Add-Type
 * compiles the same native chain a C++ N-API addon would call
 * (OpenProcessToken → DuplicateTokenEx → SetTokenInformation(Low-IL) →
 * CreateProcessAsUserW → WaitForSingleObject → GetExitCodeProcess) — .NET is
 * preinstalled on every Windows host, so no node-gyp toolchain is required.
 * The helper WAITS on the child and exits with the child's exit code; the
 * child inherits the helper's stdout/stderr handles, so exit codes and output
 * propagate through helperRunner contract v2 to the tool's normal spawn.
 *
 * The `runas /trustlevel:0x20000` prototype remains as the in-script
 * fallback: if the .NET machinery cannot load, the script degrades to the
 * detached launcher (containment preserved; exit code / stdio propagation
 * lost by definition).
 *
 * Known-fixed P/Invoke pitfalls (see SAGE plan-28 note): TOKEN_MANDATORY_LABEL
 * must use natural alignment; `lpApplicationName` must be an absolute path
 * (bare-name lookup fails under the restricted token); `lpCurrentDirectory`
 * must be inside the sandbox (first writable root).
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';
import { getResolvedSandboxConfig } from './manager.js';
import type { SandboxConfig, SandboxRoute } from './types.js';

export type SandboxHelperRunner = (
  route: SandboxRoute,
  config?: SandboxConfig,
) => Promise<SandboxRoute | void>;

function markLowIntegrity(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      spawnSync('icacls', [dir, '/setintegritylevel', 'L'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: buildChildEnv(),
      });
    } catch {
      // Best-effort: a failed mark is caught by the containment proof, not here.
    }
  }
}

// No literal backslashes inside this template literal — the JS engine eats
// unknown escape sequences (`\c` → `c`). Runtime paths are built with
// Join-Path; payload text travels base64-encoded.
const HELPER_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$EncodedPayload,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
$ErrorActionPreference = 'Stop'
$payload = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($EncodedPayload))
$app = Join-Path (Join-Path $env:SystemRoot 'System32') 'cmd.exe'
$definition = @'
using System;
using System.Runtime.InteropServices;

public static class RestrictedSpawn
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public int Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOW { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, int desired, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr existing, int desired, ref SECURITY_ATTRIBUTES attrs, int impersonationLevel, int tokenType, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref TOKEN_MANDATORY_LABEL info, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSidToSid(string sidString, out IntPtr sidPtr);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int handle);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CreateProcessAsUserW(IntPtr token, string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, int creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOW startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

    // Spawns the payload under a Low-integrity duplicate of the current token,
    // WAITS for it, and returns its real exit code. Negative returns are
    // fail-closed diagnostics (-class*10000 - win32 error); the caller script
    // surfaces them as its own exit code.
    public static int Run(string applicationName, string commandLine, string workingDirectory)
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0020, out token)) return -10400 - Marshal.GetLastWin32Error();
        var attrs = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr duplicate;
        if (!DuplicateTokenEx(token, 0x02000000, ref attrs, 2, 1, out duplicate)) { var e = Marshal.GetLastWin32Error(); CloseHandle(token); return -10500 - e; }
        IntPtr sidPtr;
        if (!ConvertStringSidToSid("S-1-16-4096", out sidPtr)) { var e = Marshal.GetLastWin32Error(); CloseHandle(duplicate); CloseHandle(token); return -10200 - e; }
        var label = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = sidPtr, Attributes = 0 } };
        if (!SetTokenInformation(duplicate, 25, ref label, Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)))) { var e = Marshal.GetLastWin32Error(); CloseHandle(duplicate); CloseHandle(token); return -20000 - e; }
        var si = new STARTUPINFOW();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
        si.dwFlags = 0x00000100; // STARTF_USESTDHANDLES — inherit our captured pipes.
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        if (!CreateProcessAsUserW(duplicate, applicationName, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero, workingDirectory, ref si, out pi)) { var e = Marshal.GetLastWin32Error(); CloseHandle(duplicate); CloseHandle(token); return -30000 - e; }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, -1);
        int exitCode;
        if (!GetExitCodeProcess(pi.hProcess, out exitCode)) { var e = Marshal.GetLastWin32Error(); CloseHandle(pi.hProcess); CloseHandle(duplicate); CloseHandle(token); return -40000 - e; }
        CloseHandle(pi.hProcess); CloseHandle(duplicate); CloseHandle(token);
        return exitCode;
    }
}
'@
try {
  Add-Type -TypeDefinition $definition
  $exit = [RestrictedSpawn]::Run($app, '/d /s /c "' + $payload + '"', $WorkDir)
  exit $exit
} catch {
  # .NET machinery unavailable — the runas prototype keeps containment
  # (detached: no exit code / stdio by definition).
  & runas /trustlevel:0x20000 $payload
  exit 0
}
`;

let scriptPath: string | undefined;

function materializeHelperScript(): string {
  if (!scriptPath) {
    scriptPath = join(tmpdir(), `wstack-sandbox-helper-${process.pid}.ps1`);
    writeFileSync(scriptPath, HELPER_SCRIPT, { encoding: 'utf8' });
  }
  return scriptPath;
}

export function defaultWindowsHelperRunner(): SandboxHelperRunner {
  return async (route, callerConfig) => {
    const payload = route.command ?? route.argv?.join(' ');
    if (!payload) return;
    const config = callerConfig ?? getResolvedSandboxConfig();
    const writableRoots =
      config.tier === 'workspace-write' ? config.writableRoots.filter(Boolean) : [];
    markLowIntegrity(writableRoots);
    const scriptPath2 = materializeHelperScript();
    // The payload travels base64(UTF-16LE) so no quoting layer can mangle it.
    // Child working directory = first writable root (inside the sandbox — a
    // Medium-IL working directory fails CreateProcessAsUserW with err 267).
    return {
      argv: [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath2,
        '-EncodedPayload',
        Buffer.from(payload, 'utf16le').toString('base64'),
        '-WorkDir',
        writableRoots[0] ?? process.cwd(),
      ],
    };
  };
}

/**
 * Test/integration seam: spawn the helper route directly and resolve with the
 * propagated exit code plus the child's captured stdout/stderr (the helper
 * waits on the payload and inherits our pipes — T5.2).
 */
export function runHelperRoute(
  route: SandboxRoute,
  timeoutMs = 120_000,
): Promise<{ code: number | null; out: string }> {
  const argv = route.argv ?? [];
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? 'powershell.exe', argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
      env: buildChildEnv(),
    });
    let out = '';
    child.stdout?.on('data', (chunk: unknown) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code: number | null) => resolve({ code, out }));
  });
}
