import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const shellHarness = `#!/bin/sh
set -eu
fixture_root="$WSTACK_TEST_ROOT"
installer="$WSTACK_TEST_INSTALLER"
if command -v cygpath >/dev/null 2>&1; then
  fixture_root=$(cygpath -u "$fixture_root")
  installer=$(cygpath -u "$installer")
fi
HOME="$fixture_root/home with 'quote'"
mkdir -p "$HOME" "$fixture_root/tools"
export HOME SHELL=/bin/bash
WSTACK_TEST_LOG="$fixture_root/events.log"
export WSTACK_TEST_LOG
export WSTACK_INSTALL_DIR="$HOME/.wrongstack/bin"
export WSTACK_DOWNLOAD_BASE=https://fixture.invalid/releases WSTACK_MIGRATION=1
export BUN_INSTALL="$fixture_root/bun"
export WSTACK_TEST_ROOT="$fixture_root"
cat > "$fixture_root/fixture" <<'BINARY'
#!/bin/sh
printf 'version\\n' >> "$WSTACK_TEST_LOG"
[ "$WSTACK_TEST_MODE" != binary ] || exit 2
printf '1.2.3\\n'
BINARY
chmod +x "$fixture_root/fixture"
cat > "$fixture_root/tools/curl" <<'CURL'
#!/bin/sh
while [ "$1" != -o ]; do shift; done
out=$2; url=$3
case "$url" in
  */SHA256SUMS)
    hash=$(sha256sum "$WSTACK_TEST_ROOT/fixture" | cut -d' ' -f1)
    [ "$WSTACK_TEST_MODE" != checksum ] || hash=invalid
    printf '%s  wstack-linux-x64\\n' "$hash" > "$out" ;;
  *) cp "$WSTACK_TEST_ROOT/fixture" "$out" ;;
esac
CURL
cat > "$fixture_root/tools/uname" <<'UNAME'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac
UNAME
# Keep platform detection deterministic on musl CI hosts.
cat > "$fixture_root/tools/ldd" <<'LDD'
#!/bin/sh
echo glibc
LDD
for pm in npm pnpm yarn bun; do
  root="$fixture_root/$pm/node_modules"
  [ "$pm" != bun ] || root="$BUN_INSTALL/install/global/node_modules"
  mkdir -p "$root/wrongstack" "$root/@wrongstack/cli"
  printf '{}' > "$root/wrongstack/package.json"
  printf '{}' > "$root/@wrongstack/cli/package.json"
  cat > "$fixture_root/tools/$pm" <<'PM'
#!/bin/sh
pm=$(basename "$0")
root="$WSTACK_TEST_ROOT/$pm/node_modules"
[ "$pm" != bun ] || root="$BUN_INSTALL/install/global/node_modules"
if [ "$1" = root ]; then echo "$root"; exit; fi
if [ "$pm" = yarn ] && [ "$2" = dir ]; then echo "$WSTACK_TEST_ROOT/yarn"; exit; fi
printf 'remove %s %s\\n' "$pm" "$*" >> "$WSTACK_TEST_LOG"
[ "$WSTACK_TEST_MODE" != cleanup ] || exit 1
for arg; do pkg=$arg; done
rm "$root/$pkg/package.json"
PM
done
chmod +x "$fixture_root/tools/"*
PATH="$fixture_root/tools:$PATH"
export PATH
/bin/sh "$installer"
# Load the persisted PATH in a fresh shell and run the canonical command.
PATH=/usr/bin:/bin /bin/sh -c '. "$HOME/.bashrc"; command -v wstack; wstack version'
`;

// Exercise the shipped installer itself. Only downloads and package managers
// are fixtures; no user installation or persistent user PATH is touched.
describe('standalone installer migration', () => {
  const gitBash = path.join(
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    'Git',
    'bin',
    'bash.exe',
  );
  const kinds =
    process.platform === 'win32' && existsSync(gitBash) ? ['native', 'posix'] : ['native'];
  // Git Bash emulates fork() by launching and copying a whole Windows process, so
  // the posix harness's dozens of subshells and commands cost one process launch
  // each. On a loaded Windows host a launch can take 0.3-1 s, which pushes the
  // harness past 30 s without anything hanging; give that combination headroom.
  const harnessTimeoutMs = (kind: string) =>
    process.platform === 'win32' && kind === 'posix' ? 120_000 : 30_000;
  it.each(
    [
      { mode: 'success', status: 0, removals: 8 },
      { mode: 'checksum', status: 1, removals: 0 },
      { mode: 'binary', status: 1, removals: 0 },
      { mode: 'cleanup', status: 1, removals: 8 },
    ].flatMap((test) => kinds.map((kind) => ({ ...test, kind }))),
  )(
    '$kind/$mode: verifies the binary before removing legacy packages',
    ({ mode, status, removals, kind }) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wstack-installer-test-'));
      try {
        const log = path.join(dir, 'events.log');
        writeFileSync(log, '');
        const windows = process.platform === 'win32' && kind === 'native';
        const installer = path.resolve(
          import.meta.dirname,
          `../../../scripts/install.${windows ? 'ps1' : 'sh'}`,
        );
        // The Windows harness compiles a tiny executable so the actual invocation
        // and its exit status are tested, rather than mocking the version check.
        const harness = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$FixtureRoot = $env:WSTACK_TEST_ROOT
$env:WSTACK_INSTALL_DIR = Join-Path $FixtureRoot 'installed'
$env:BUN_INSTALL = Join-Path $FixtureRoot 'bun'
$env:WSTACK_DOWNLOAD_BASE = 'https://fixture.invalid/releases'
$env:WSTACK_MIGRATION = '1'
$env:WSTACK_NO_MODIFY_PATH = '1'
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:PROCESSOR_ARCHITEW6432 = ''
$FixtureExe = Join-Path $FixtureRoot 'fixture.exe'
Add-Type -OutputAssembly $FixtureExe -OutputType ConsoleApplication -TypeDefinition @'
public class Fixture {
  public static int Main(string[] args) {
    System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("WSTACK_TEST_LOG"), "version\\n");
    if (System.Environment.GetEnvironmentVariable("WSTACK_TEST_MODE") == "binary") return 2;
    System.Console.WriteLine("1.2.3"); return 0;
  }
}
'@
foreach ($Pm in 'npm', 'pnpm', 'yarn', 'bun') {
  $GlobalDir = if ($Pm -eq 'bun') { Join-Path $FixtureRoot 'bun/install/global/node_modules' } else { Join-Path $FixtureRoot "$Pm/node_modules" }
  foreach ($Pkg in 'wrongstack', '@wrongstack/cli') {
    $PkgDir = Join-Path $GlobalDir $Pkg
    New-Item -ItemType Directory -Force $PkgDir | Out-Null
    Set-Content (Join-Path $PkgDir 'package.json') '{}'
  }
}
# Load the hash cmdlet before overriding command discovery for package managers.
Get-FileHash -Algorithm SHA256 $FixtureExe | Out-Null
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing)
  if ($Uri.EndsWith('/SHA256SUMS')) {
    $Hash = (Get-FileHash -Algorithm SHA256 $FixtureExe).Hash.ToLower()
    if ($env:WSTACK_TEST_MODE -eq 'checksum') { $Hash = '0' * 64 }
    Set-Content $OutFile "$Hash  wstack-windows-x64.exe"
  } else { Copy-Item -LiteralPath $FixtureExe -Destination $OutFile }
}
function Get-Command {
  param([string[]]$Name, [switch]$All, $ErrorAction)
  if ($Name.Count -eq 1 -and $Name[0] -in @('npm', 'pnpm', 'yarn', 'bun')) {
    [pscustomobject]@{ Name = $Name[0] }
  }
}
function Invoke-FixturePm {
  param([string]$Manager, [string[]]$PmArgs)
  $global:LASTEXITCODE = 0
  if ($PmArgs[0] -eq 'root') { Join-Path $FixtureRoot "$Manager/node_modules"; return }
  if ($Manager -eq 'yarn' -and $PmArgs[1] -eq 'dir') { Join-Path $FixtureRoot 'yarn'; return }
  Add-Content $env:WSTACK_TEST_LOG ("remove " + $Manager + ' ' + ($PmArgs -join ' '))
  if ($env:WSTACK_TEST_MODE -eq 'cleanup') { $global:LASTEXITCODE = 1; return }
  $GlobalDir = if ($Manager -eq 'bun') { Join-Path $FixtureRoot 'bun/install/global/node_modules' } else { Join-Path $FixtureRoot "$Manager/node_modules" }
  $Manifest = Join-Path $GlobalDir ($PmArgs[-1] + '/package.json')
  Remove-Item -LiteralPath $Manifest
}
function npm { Invoke-FixturePm 'npm' $args }
function pnpm { Invoke-FixturePm 'pnpm' $args }
function yarn { Invoke-FixturePm 'yarn' $args }
function bun { Invoke-FixturePm 'bun' $args }
& $env:WSTACK_TEST_INSTALLER
`;
        const file = path.join(dir, windows ? 'harness.ps1' : 'harness.sh');
        writeFileSync(file, windows ? harness : shellHarness);
        const interpreter = windows
          ? path.join(
              process.env['SystemRoot'] ?? 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            )
          : process.platform === 'win32'
            ? gitBash
            : '/bin/sh';
        const result = spawnSync(
          interpreter,
          windows
            ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
            : [file.replaceAll('\\', '/')],
          {
            env: {
              ...process.env,
              WSTACK_TEST_ROOT: dir,
              WSTACK_TEST_LOG: log,
              WSTACK_TEST_MODE: mode,
              WSTACK_TEST_INSTALLER: installer,
            },
            encoding: 'utf8',
            timeout: harnessTimeoutMs(kind),
            windowsHide: true,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(status);
        if (mode === 'checksum') expect(result.stderr).toContain('checksum mismatch');
        if (mode === 'binary') expect(result.stderr).toContain('installed binary could not run');
        if (mode === 'cleanup')
          expect(result.stderr).toContain('legacy package cleanup is incomplete');
        const events = readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        expect(events.filter((event) => event.startsWith('remove '))).toHaveLength(removals);
        if (removals) {
          expect(events[0]).toBe('version');
          for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
            expect(
              events.some(
                (event) => event.startsWith(`remove ${manager} `) && event.endsWith('wrongstack'),
              ),
            ).toBe(true);
            expect(
              events.some(
                (event) =>
                  event.startsWith(`remove ${manager} `) && event.endsWith('@wrongstack/cli'),
              ),
            ).toBe(true);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // Above the harness budget, so a real hang still fails on spawnSync's ETIMEDOUT.
    Math.max(...kinds.map(harnessTimeoutMs)) + 30_000,
  );
});
