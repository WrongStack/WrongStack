import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bash/pwsh kill guard must protect the RUNNING WrongStack runtime by image
 * name even when the persistent process registry holds no live entry — the rule
 * exec-kill-guard already applies ("the guard runs inside the current WrongStack
 * process, which may not have been written to the registry yet … a broad
 * image-name kill matching the current runtime would therefore kill WrongStack
 * even when the registry is empty"). isKillProtected consulted only registry
 * entries and the literal `wrongstack` / `node` substrings, so
 * `taskkill /IM bun.exe`, `Stop-Process -Name bun` and `tskill bun` — the very
 * runtime of this process — walked past it while exec blocked all three.
 *
 * The registry is mocked EMPTY and process.execPath is pinned, so the verdicts
 * depend on nothing but the runtime image. Both platform branches run on every
 * host by mocking `node:os` (the guard fixes its platform at module load).
 */

vi.mock('../src/process-registry-persistent.js', () => ({
  isEntryFromThisHost: () => true,
  getPersistentProcessRegistry: () => ({
    shouldBlockKill: async () => false,
    getAllProtectedPids: async () => [],
    getGlobalStatus: async () => ({ instances: new Map() }),
  }),
}));

const realExecPath = process.execPath;

async function loadGuard(platform: 'linux' | 'darwin' | 'win32') {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const patched = { ...actual, platform: () => platform };
    return { ...patched, default: patched };
  });
  return import('../src/bash-kill-guard.js');
}

function pinRuntime(image: string): void {
  Object.defineProperty(process, 'execPath', {
    value: path.join(path.dirname(realExecPath), image),
    configurable: true,
    writable: true,
  });
}

beforeEach(() => pinRuntime('bun.exe'));
afterEach(() => {
  Object.defineProperty(process, 'execPath', {
    value: realExecPath,
    configurable: true,
    writable: true,
  });
  vi.doUnmock('node:os');
});

describe('bash-kill-guard — protects the running runtime image (empty registry)', () => {
  it.each(['linux', 'darwin'] as const)(
    'protects PowerShell targets on %s without launching a kill command',
    async (platform) => {
      const { checkAndBlockKillCommand } = await loadGuard(platform);
      for (const command of [
        `Stop-Process -Id ${process.pid}`,
        `Stop-Process -Id:${process.ppid} -Force`,
        `spps ${process.pid} -Force`,
        `kill -Id ${process.pid}`,
        `pwsh -NoProfile -Command "Stop-Process -Id ${process.pid}"`,
        `pwsh -Command "kill ${process.pid}"`,
        'Stop-Process -Name bun',
        'spps -Name bun',
        'pwsh -Command "Stop-Process -Name bun"',
      ]) {
        expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
      }
    },
  );

  it.each(['linux', 'darwin'] as const)(
    'preserves unrelated targets and POSIX protection on %s',
    async (platform) => {
      const { checkAndBlockKillCommand } = await loadGuard(platform);
      expect((await checkAndBlockKillCommand(`kill -9 ${process.pid}`)).blocked).toBe(true);
      for (const command of [
        'Stop-Process -Id 2147483646',
        'Stop-Process -Name unrelated-test-image',
        'kill -9 2147483646',
        'Write-Output hello',
      ]) {
        expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
      }
    },
  );

  it.each([
    'taskkill /F /IM bun.exe',
    'taskkill /F /IM bun',
    'taskkill /F /IM BUN.EXE',
    'taskkill /IM:bun.exe /F',
    'taskkill /F /FI "IMAGENAME eq bun.exe"',
    'Stop-Process -Name bun',
    'Stop-Process -Name bun -Force',
    'Stop-Process -Name:bun',
    'Stop-Process -Name BUN',
    'tskill bun',
    'tskill /A bun',
    'taskkill /F /IM bu*',
    'Stop-Process -Name bu*',
    'taskkill /F /IM *',
    'true; taskkill /F /IM bun.exe',
  ])('blocks %s', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
  });

  // `taskkill /FI "PID <op> <n>"` selects a PID SET, so it never names a single
  // PID: every inequality spelling parsed to no target and the guard allowed
  // `taskkill /F /FI "PID ge 1"`, which force-kills this runtime.
  it.each([
    ['ge', (pid: number) => pid - 1],
    ['gt', (pid: number) => pid - 1],
    ['le', (pid: number) => pid],
    ['lt', (pid: number) => pid + 1],
    ['ne', (pid: number) => pid + 1],
  ])('blocks taskkill /FI "PID %s <n>" when the range selects this runtime', async (op, value) => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const command = `taskkill /F /FI "PID ${op} ${value(process.pid)}"`;
    expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
  });

  it.each([
    'taskkill /F /FI "PID lt 1"',
    'taskkill /F /FI "PID eq 2147483646"',
    'taskkill /F /FI "PID gt 2147483646"',
  ])('still allows %s', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
  });

  // `... call terminate` is the WMIC method spelling of `... delete`: both
  // terminate the matched process. The detector gated on `delete` alone, so the
  // method spelling was never parsed and the guard allowed it outright.
  it('blocks wmic call terminate, the method spelling of delete', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const self = process.pid;
    for (const command of [
      `wmic process where processid=${self} call terminate`,
      "wmic process where name='wrongstack.exe' call terminate",
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
    }
    // This layer is precise for PIDs: an unprotected target stays allowed in
    // both verb spellings (no blanket block on the method spelling).
    const viaDelete = await checkAndBlockKillCommand('wmic process where "ProcessId=4242" delete');
    const viaMethod = await checkAndBlockKillCommand(
      'wmic process where "ProcessId=4242" Call Terminate',
    );
    expect(viaDelete.blocked).toBe(false);
    expect(viaMethod.blocked).toBe(viaDelete.blocked);
  });

  it('keeps the wmic method spelling precise: unrelated filters stay allowed', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    for (const command of [
      "wmic process where name='notepad.exe' call terminate",
      'wmic os get caption',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
    }
  });

  // A launcher binds its payload as one token, so separators inside its quotes
  // are invisible to a split of the raw line — the kill sequenced after them
  // ran uninspected.
  it('blocks a kill sequenced inside a launcher payload', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    for (const command of [
      'cmd /c "echo hi && taskkill /F /IM bun.exe"',
      'cmd /c "echo hi & taskkill /F /IM bun.exe"',
      'cmd /c "echo hi || taskkill /F /IM bun.exe"',
      'cmd /c "taskkill /F /IM bun.exe && exit"',
      'cmd /k "echo hi && taskkill /F /IM bun.exe"',
      'powershell -NoProfile -Command "echo hi; Stop-Process -Name bun"',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
    }
  });

  it('keeps launcher-payload sequencing precise for unprotected targets', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    for (const command of [
      'cmd /c "echo hi && echo bye"',
      'cmd /c "echo hi && taskkill /F /IM notepad.exe"',
      'cmd /c "echo hi && taskkill /F /PID 2147483646"',
      'powershell -Command "echo hi; Get-Process"',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
    }
  });

  // PowerShell binds a quoted string to a typed parameter and the value is what
  // it binds: `-Id:'<pid>'`, `-Id "<pid>"` and `-Name:'wrongstack'` all kill
  // (live-verified for the colon+quoted PID form). The parser matched only bare
  // values, so the quoted spelling produced no target and was allowed.
  it('blocks quoted Stop-Process parameter values', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const self = process.pid;
    for (const command of [
      `Stop-Process -Id:'${self}'`,
      `Stop-Process -Id:"${self}"`,
      `Stop-Process -Id '${self}'`,
      `Stop-Process -Id "${self}"`,
      "Stop-Process -Name:'wrongstack'",
      'Stop-Process -Name:"wrongstack"',
      "spps -Name:'wrongstack'",
      `powershell -Command "Stop-Process -Id:'${self}'"`,
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
    }
    for (const command of ["Stop-Process -Id:'2147483646'", "Stop-Process -Name:'notepad.exe'"]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
    }
  });

  // Redirection only discards output; it names no different process. The
  // simple-taskkill gate rejected any `<`/`>`, so the same kill with `> nul`,
  // `2>nul`, `>> log`, `2>&1` or `< nul` was allowed while the bare command
  // was blocked.
  it('blocks taskkill with IO redirection', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const self = process.pid;
    for (const command of [
      'taskkill /F /IM wrongstack.exe > nul',
      'taskkill /F /IM wrongstack.exe 2>nul',
      `taskkill /F /PID ${self} >nul`,
      'taskkill /F /IM wrongstack.exe >nul 2>&1',
      'taskkill /F /IM wrongstack.exe >> log.txt',
      'taskkill /F /IM wrongstack.exe < nul',
      `taskkill /F /FI "PID eq ${self}" > nul`,
      'cmd /c taskkill /F /IM wrongstack.exe > nul',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
    }
    for (const command of [
      'taskkill /F /IM notepad.exe > nul',
      'taskkill /F /PID 2147483646 > nul',
      'echo hi > nul',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
    }
  });

  // `%ComSpec%` is cmd's own path, so `cmd /c %ComSpec% /c taskkill …` runs the
  // kill in a nested interpreter. Recognising only the literal `cmd` head left
  // the payload uninspected while `cmd /c taskkill …` was blocked.
  it('blocks a kill through the %ComSpec% interpreter alias', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const self = process.pid;
    for (const command of [
      'cmd /c %ComSpec% /c taskkill /F /IM wrongstack.exe',
      '%ComSpec% /c taskkill /F /IM wrongstack.exe',
      `cmd.exe /c %COMSPEC% /c taskkill /F /PID ${self}`,
      'cmd /c "%ComSpec% /c taskkill /F /IM wrongstack.exe"',
      'cmd /c %ComSpec% /c "taskkill /F /IM wrongstack.exe"',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(true);
    }
    for (const command of [
      '%ComSpec% /c echo hi',
      'cmd /c %ComSpec% /c echo hi',
      'cmd /c %ComSpec% /c taskkill /F /IM notepad.exe',
      'echo %ComSpec%',
    ]) {
      expect((await checkAndBlockKillCommand(command)).blocked, command).toBe(false);
    }
  });

  it.each(['pkill bun', 'pkill -9 bun', 'killall bun', 'true && pkill bun'])(
    'blocks POSIX %s',
    async (command) => {
      const { checkAndBlockKillCommand } = await loadGuard('linux');
      expect((await checkAndBlockKillCommand(command)).blocked).toBe(true);
    },
  );

  it('follows the runtime that is actually running', async () => {
    pinRuntime('node.exe');
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    expect((await checkAndBlockKillCommand('taskkill /F /IM node.exe')).blocked).toBe(true);
    // bun is not this process's runtime any more, and the registry is empty
    expect((await checkAndBlockKillCommand('taskkill /F /IM bun.exe')).blocked).toBe(false);
  });

  it.each([
    'taskkill /F /IM notepad.exe',
    'taskkill /F /IM bunny.exe',
    'taskkill /F /IM mybun.exe',
    'Stop-Process -Name notepad',
    'Stop-Process -Name mybun',
    'Stop-Process -Name bunny',
    'tskill notepad',
    'taskkill /F /PID 4242',
  ])('still allows %s', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
  });

  it('keeps the hard `wrongstack` name block', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    for (const command of ['taskkill /F /IM wrongstack.exe', 'Stop-Process -Name wrongstack']) {
      expect((await checkAndBlockKillCommand(command)).blocked).toBe(true);
    }
  });

  it('agrees with the exec guard on the runtime image', async () => {
    const { checkAndBlockKillCommand } = await loadGuard('win32');
    const { checkExecKillCommand } = await import('../src/exec-kill-guard.js');
    for (const [cmd, args] of [
      ['taskkill', ['/F', '/IM', 'bun.exe']],
      ['taskkill', ['/F', '/IM', 'bun.exe', '>', 'nul']],
      ['Stop-Process', ['-Name', 'bun']],
      ['tskill', ['bun']],
    ] as const) {
      const exec = (await checkExecKillCommand(cmd, [...args])).blocked;
      const bash = (await checkAndBlockKillCommand(`${cmd} ${args.join(' ')}`)).blocked;
      expect({ cmd, exec, bash }).toEqual({ cmd, exec: true, bash: true });
    }
  });
});
