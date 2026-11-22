import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the persistent process registry to isolate kill guard tests.
// Returns empty protections so that none of the PID/name checks trip unless
// we specifically want them to.
vi.mock('../src/process-registry-persistent.js', () => ({
  getPersistentProcessRegistry: () => ({
    shouldBlockKill: vi.fn().mockResolvedValue(false),
    getAllProtectedPids: vi.fn().mockResolvedValue([]),
  }),
  PersistentProcessRegistry: class {},
}));

import { checkExecKillCommand } from '../src/exec-kill-guard.js';

const isWin = os.platform() === 'win32';
const actualExecPath = process.execPath;
beforeEach(() => {
  process.execPath = path.join(path.dirname(actualExecPath), isWin ? 'node.exe' : 'node');
});
afterEach(() => {
  process.execPath = actualExecPath;
});

describe('exec-kill-guard', () => {
  it('protects a Bun host even before the process registry has been populated', async () => {
    process.execPath = path.join(path.dirname(actualExecPath), isWin ? 'bun.exe' : 'bun');
    const result = await checkExecKillCommand(
      isWin ? 'taskkill' : 'pkill',
      isWin ? ['/IM', 'bun.exe'] : ['bun'],
    );
    expect(result.blocked).toBe(true);
    expect(
      (await checkExecKillCommand('bun', ['-e', `process.kill(${process.pid})`])).blocked,
    ).toBe(true);
    expect(
      (
        await checkExecKillCommand(
          isWin ? 'taskkill' : 'pkill',
          isWin ? ['/IM', 'unrelated.exe'] : ['unrelated'],
        )
      ).blocked,
    ).toBe(false);
  });
  describe('empty / edge inputs', () => {
    it('returns not blocked for empty command', async () => {
      const result = await checkExecKillCommand('', []);
      expect(result.blocked).toBe(false);
    });

    it('returns not blocked for null/undefined command', async () => {
      const result = await checkExecKillCommand('' as never, []);
      expect(result.blocked).toBe(false);
    });
  });

  // ── Windows-only tests ───────────────────────────────────────────────
  describe.runIf(isWin)('Windows kill variants', () => {
    it('blocks taskkill /IM node.exe', async () => {
      const result = await checkExecKillCommand('taskkill', ['/IM', 'node.exe', '/F']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/node/);
    });

    it('blocks taskkill /F /IM node.exe', async () => {
      const result = await checkExecKillCommand('taskkill', ['/F', '/IM', 'node.exe']);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill /PID targeting current process', async () => {
      const result = await checkExecKillCommand('taskkill', [
        '/F',
        '/PID',
        String(process.pid),
        '/T',
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it.each([
      ['C:\\Windows\\System32\\taskkill.exe', ['/PID', String(process.pid), '/F']],
      ['taskkill', [`/PID:${process.pid}`, '/F']],
      ['C:\\Windows\\System32\\cmd.exe', ['/c', 'taskkill', '/PID', String(process.pid)]],
      ['cmd', ['/k', 'taskkill', '/PID', String(process.pid)]],
      ['tskill', [String(process.pid)]],
      ['powershell', [`Stop-Process -Id ${process.pid}`]],
      ['pwsh', ['-c', `Stop-Process ${process.pid}`]],
    ] as const)('blocks a self-kill spelled %s %j', async (cmd, args) => {
      expect((await checkExecKillCommand(cmd, [...args])).blocked).toBe(true);
    });

    // `tskill <process name>` kills EVERY process with that image name (live-
    // verified on a renamed copy of ping: `tskill r9proc`, `/A` and `/V` before or
    // after the name, any case; tskill itself rejects a `.exe` suffix). Only the
    // numeric `tskill <pid>` form was checked, so naming the runtime's own image
    // or "wrongstack" walked past the guard.
    describe('tskill <process name> is a name kill', () => {
      // beforeEach re-points process.execPath, so the runtime image is resolved
      // at test time (a collection-time value would name a different binary).
      const IMAGE = '$IMAGE';
      const currentImage = () =>
        path
          .basename(process.execPath)
          .toLowerCase()
          .replace(/\.exe$/, '');
      const resolve = (args: readonly string[]) =>
        args.map((a) => a.replace(IMAGE, currentImage()).replace(`"${IMAGE}"`, currentImage()));

      it.each([
        [IMAGE],
        ['/A', IMAGE],
        [IMAGE, '/A'],
        [IMAGE, '/V'],
        ['/A', '/V', IMAGE],
        [`"${IMAGE}"`],
        ['wrongstack'],
        ['WrongStack'],
        ['/A', 'wrongstack'],
      ])('blocks tskill %j', async (...args) => {
        expect((await checkExecKillCommand('tskill', resolve(args))).blocked).toBe(true);
      });

      it('is case-insensitive for the runtime image', async () => {
        const r = await checkExecKillCommand('tskill', [currentImage().toUpperCase()]);
        expect(r.blocked).toBe(true);
      });

      it('names the target in the reason', async () => {
        const r = await checkExecKillCommand('tskill', ['wrongstack']);
        expect(r.reason).toMatch(/wrongstack/i);
      });

      it.each([['notepad'], ['/A', 'notepad'], ['notepad', '/V'], ['/?'], ['/A'], [], ['4242']])(
        'still allows tskill %j',
        async (...args) => {
          expect((await checkExecKillCommand('tskill', args)).blocked).toBe(false);
        },
      );
    });

    it('blocks taskkill /PID targeting current process (dash flags)', async () => {
      const result = await checkExecKillCommand('taskkill', ['-F', '-PID', String(process.pid)]);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill.exe with full extension', async () => {
      const result = await checkExecKillCommand('taskkill.exe', ['/IM', 'node.exe']);
      expect(result.blocked).toBe(true);
    });

    it('blocks taskkill with /FI IMAGENAME filter', async () => {
      const result = await checkExecKillCommand('taskkill', ['/F', '/FI', 'IMAGENAME eq node.exe']);
      expect(result.blocked).toBe(true);
    });

    // `taskkill /FI "PID eq <n>"` terminates <n> exactly like `/PID <n>` (live-
    // verified: "SUCCESS: The process with PID <n> has been terminated"). Only
    // the IMAGENAME filter was parsed, so the PID filter walked past the guard.
    describe('taskkill /FI "PID eq <n>" is a PID kill', () => {
      const self = String(process.pid);
      it.each([
        ['/F', '/FI', `PID eq ${self}`],
        ['/F', '/FI', `pid eq ${self}`],
        ['/F', '/FI', `PID EQ ${self}`],
        ['/FI', `PID eq ${self}`, '/F'],
        ['/F', '/FI', `PID  eq  ${self}`],
        ['/F', '/T', '/FI', `PID eq ${self}`],
        ['-F', '-FI', `PID eq ${self}`],
      ])('blocks taskkill %j', async (...args) => {
        expect((await checkExecKillCommand('taskkill', args)).blocked).toBe(true);
      });

      it('reports the same reason as the /PID spelling', async () => {
        const viaFilter = await checkExecKillCommand('taskkill', ['/F', '/FI', `PID eq ${self}`]);
        const viaPid = await checkExecKillCommand('taskkill', ['/F', '/PID', self]);
        expect(viaFilter.reason).toBe(viaPid.reason);
        expect(viaFilter.reason).toMatch(/current WrongStack process/);
      });

      it.each([
        ['/F', '/FI', 'PID eq 4242'],
        ['/F', '/FI', 'STATUS eq RUNNING'],
        ['/F', '/FI', 'IMAGENAME eq notepad.exe'],
        ['/F', '/FI', 'PID eq notanumber'],
      ])('still allows taskkill %j', async (...args) => {
        expect((await checkExecKillCommand('taskkill', args)).blocked).toBe(false);
      });

      // `taskkill /FI "PID <ne|gt|ge|lt|le> <n>"` names a PID SET, not one PID,
      // so it never reached the /PID check: `taskkill /F /FI "PID ge 1"` walked
      // past this guard while the `eq` spelling was blocked.
      describe('taskkill /FI "PID <op> <n>" range filters', () => {
        const self = process.pid;
        it.each([
          ['/F', '/FI', `PID ge ${self - 1}`],
          ['/F', '/FI', `PID gt ${self - 1}`],
          ['/F', '/FI', `PID le ${self}`],
          ['/F', '/FI', `PID lt ${self + 1}`],
          ['/F', '/FI', `PID ne ${self + 1}`],
        ])('blocks taskkill %j when the range selects this runtime', async (...args) => {
          expect((await checkExecKillCommand('taskkill', args)).blocked).toBe(true);
        });

        it.each([
          ['/F', '/FI', 'PID lt 1'],
          ['/F', '/FI', `PID gt ${2_147_483_646}`],
          ['/F', '/FI', `PID eq ${2_147_483_646}`],
        ])('still allows taskkill %j', async (...args) => {
          expect((await checkExecKillCommand('taskkill', args)).blocked).toBe(false);
        });
      });
    });
    it('still checks other /PID args when /IM does not match', async () => {
      // /IM with a non-node name should still check /PID later
      const result = await checkExecKillCommand('taskkill', [
        '/IM',
        'myapp.exe',
        '/F',
        '/PID',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('returns not blocked for taskkill targeting unrelated process', async () => {
      const result = await checkExecKillCommand('taskkill', ['/F', '/PID', '99999999']);
      expect(result.blocked).toBe(false);
    });

    it('blocks PowerShell Stop-Process -Name node', async () => {
      const result = await checkExecKillCommand('powershell', [
        '-Command',
        'Stop-Process -Name node -Force',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks PowerShell Stop-Process -Id current PID', async () => {
      const result = await checkExecKillCommand('pwsh', [
        '-Command',
        `Stop-Process -Id ${process.pid}`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks cmd /c with taskkill (shell indirection)', async () => {
      const result = await checkExecKillCommand('cmd', [
        '/c',
        `taskkill /F /PID ${process.pid} /T`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks Stop-Process alias kill with -Name', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-Name', 'node']);
      expect(result.blocked).toBe(true);
    });

    it('blocks Stop-Process alias kill with -Id current PID', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-Id', String(process.pid)]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks Stop-Process -id current PID (PowerShell params are case-insensitive)', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-id', String(process.pid)]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks Stop-Process -ID/-iD current PID (any case spelling)', async () => {
      for (const flag of ['-ID', '-iD']) {
        const result = await checkExecKillCommand('Stop-Process', [flag, String(process.pid)]);
        expect(result.blocked).toBe(true);
      }
    });

    it('blocks Stop-Process -name node (lowercase flag)', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-name', 'node']);
      expect(result.blocked).toBe(true);
    });

    it('still allows Stop-Process -id on an unrelated PID', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-id', '99999999']);
      expect(result.blocked).toBe(false);
    });

    it('blocks Stop-Process -Id:<pid> colon-attached current PID', async () => {
      const result = await checkExecKillCommand('Stop-Process', [`-Id:${process.pid}`]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks Stop-Process -id:<pid> colon-attached lowercase', async () => {
      const result = await checkExecKillCommand('Stop-Process', [`-id:${process.pid}`]);
      expect(result.blocked).toBe(true);
    });

    it('blocks Stop-Process -Name:node (colon-attached name)', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-Name:node']);
      expect(result.blocked).toBe(true);
    });

    it('blocks powershell -Command with colon-attached Stop-Process -Id:<pid>', async () => {
      const result = await checkExecKillCommand('powershell', [
        '-Command',
        `Stop-Process -Id:${process.pid}`,
      ]);
      expect(result.blocked).toBe(true);
    });

    it('still allows Stop-Process -Id:<unrelated pid> colon-attached', async () => {
      const result = await checkExecKillCommand('Stop-Process', ['-Id:99999999']);
      expect(result.blocked).toBe(false);
    });

    it('blocks powershell with implicit -Command (no flag)', async () => {
      const result = await checkExecKillCommand('powershell', [
        'Stop-Process',
        '-Id',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack|protected WrongStack/i);
    });

    it('blocks powershell wrapper with launcher flags before the cmdlet', async () => {
      const result = await checkExecKillCommand('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        'Stop-Process',
        '-Id',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks pwsh wrapper with implicit command (lowercase -id)', async () => {
      const result = await checkExecKillCommand('pwsh', [
        'Stop-Process',
        '-id',
        String(process.pid),
      ]);
      expect(result.blocked).toBe(true);
    });

    it('still allows powershell -File (opaque script, not recursed)', async () => {
      const result = await checkExecKillCommand('powershell', ['-File', 'script.ps1']);
      expect(result.blocked).toBe(false);
    });

    it('blocks Stop-Process alias kill with -PID flag', async () => {
      const result = await checkExecKillCommand('kill', ['-n', 'node']);
      expect(result.blocked).toBe(true);
    });

    it('blocks bare kill alias with name arg', async () => {
      const result = await checkExecKillCommand('kill', ['node']);
      expect(result.blocked).toBe(true);
    });

    it('blocks wmic process delete with name filter', async () => {
      const result = await checkExecKillCommand('wmic', [
        'process',
        'where',
        "name='node.exe'",
        'delete',
      ]);
      expect(result.blocked).toBe(true);
    });

    it('blocks wmic process delete without name filter', async () => {
      const result = await checkExecKillCommand('wmic', ['process', 'delete']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/protected WrongStack/i);
    });

    // `... call terminate` is the WMIC method spelling of `... delete`: both
    // terminate the matched process. Only `delete` was inspected, so the method
    // spelling skipped every target check.
    it.each([
      ['process', 'where', `processid=${process.pid}`, 'call', 'terminate'],
      ['process', 'where', "name='wrongstack.exe'", 'call', 'terminate'],
      ['process', 'where', `processid=${process.pid}`, 'Call', 'Terminate'],
    ])('blocks wmic process %j call terminate', async (...args) => {
      expect((await checkExecKillCommand('wmic', args)).blocked).toBe(true);
    });

    it('keeps the wmic method spelling and delete spelling in agreement', async () => {
      for (const filter of [`processid=${process.pid}`, "name='notepad.exe'", 'processid=424242']) {
        const viaDelete = await checkExecKillCommand('wmic', [
          'process',
          'where',
          filter,
          'delete',
        ]);
        const viaMethod = await checkExecKillCommand('wmic', [
          'process',
          'where',
          filter,
          'call',
          'terminate',
        ]);
        expect({ filter, method: viaMethod.blocked, del: viaDelete.blocked }).toEqual({
          filter,
          method: viaDelete.blocked,
          del: viaDelete.blocked,
        });
      }
      // Non-terminating wmic invocations stay allowed.
      expect((await checkExecKillCommand('wmic', ['os', 'get', 'caption'])).blocked).toBe(false);
    });

    // A launcher payload is one argv entry, so the wrapper used to recurse on its
    // FIRST command only and pass the rest through as that command's arguments:
    // `cmd /c "echo hi && taskkill …"` ran the kill unseen.
    describe('launcher payload sequencing', () => {
      it.each<[string, string[]]>([
        ['cmd', ['/c', 'echo hi && taskkill /F /IM wrongstack.exe']],
        ['cmd', ['/c', 'echo hi & taskkill /F /IM wrongstack.exe']],
        ['cmd', ['/c', 'echo hi || taskkill /F /IM wrongstack.exe']],
        ['cmd', ['/k', 'echo hi && taskkill /F /IM wrongstack.exe']],
        ['cmd', ['/c', '"echo hi && taskkill /F /IM wrongstack.exe"']],
        ['powershell', ['-NoProfile', '-Command', 'echo hi; Stop-Process -Name wrongstack']],
      ])('blocks %s %j', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(true);
      });

      it.each<[string, string[]]>([
        ['cmd', ['/c', 'echo hi && echo bye']],
        ['cmd', ['/c', 'echo hi && taskkill /F /IM notepad.exe']],
        ['powershell', ['-Command', 'echo hi; Get-Process']],
      ])('still allows %s %j', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(false);
      });
    });

    // `%ComSpec%` expands to cmd's own path, so a nested `cmd /c %ComSpec% /c …`
    // runs the kill in another interpreter; the recursion stopped at the
    // variable name and allowed it.
    describe('%ComSpec% interpreter alias', () => {
      it.each<[string, string[]]>([
        ['cmd', ['/c', '%ComSpec%', '/c', 'taskkill', '/F', '/IM', 'wrongstack.exe']],
        ['%ComSpec%', ['/c', 'taskkill', '/F', '/IM', 'wrongstack.exe']],
        ['cmd', ['/c', '%ComSpec% /c taskkill /F /IM wrongstack.exe']],
      ])('blocks %s %j', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(true);
      });

      it.each<[string, string[]]>([
        ['%ComSpec%', ['/c', 'echo', 'hi']],
        ['cmd', ['/c', '%ComSpec% /c taskkill /F /IM notepad.exe']],
      ])('still allows %s %j', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(false);
      });
    });

    // PowerShell binds a quoted string to a numeric parameter: `-Id:'1234'` and
    // `-Id "1234"` terminate 1234 exactly like `-Id 1234` (live-verified). The
    // quote pair hid the digits from the target parser, so the kill was allowed.
    describe('quoted parameter values', () => {
      const self = process.pid;
      it.each<string[]>([
        [`-Id:'${self}'`],
        [`-Id:"${self}"`],
        ['-Id', `'${self}'`],
        ['-Id', `"${self}"`],
      ])('blocks stop-process %j', async (...args) => {
        expect((await checkExecKillCommand('stop-process', args)).blocked).toBe(true);
      });

      it.each<string[]>([[`-Id:'2147483646'`], ["-Id:'notanumber'"]])(
        'still allows stop-process %j',
        async (...args) => {
          expect((await checkExecKillCommand('stop-process', args)).blocked).toBe(false);
        },
      );
    });

    it('blocks node -e process.kill()', async () => {
      const result = await checkExecKillCommand('node', ['-e', `process.kill(${process.pid})`]);
      expect(result.blocked).toBe(true);
    });

    it('blocks node --eval process.kill() (PID extractable)', async () => {
      const result = await checkExecKillCommand('node', ['--eval', `process.kill(${process.pid})`]);
      expect(result.blocked).toBe(true);
    });

    // `-p` / `--print` evaluate (and print) exactly like `-e`, `-pe` is the cluster,
    // and `--eval=<code>` / `--print=<code>` glue the code to the flag. Only `-e` /
    // `--eval <code>` were recognised, so every other spelling of the same eval-kill
    // walked past the check.
    describe('every node/bun eval spelling is an eval-kill', () => {
      const kill = `process.kill(${process.pid})`;
      it.each([
        ['node', ['-p', kill]],
        ['node', ['--print', kill]],
        ['node', ['-pe', kill]],
        ['node', [`--eval=${kill}`]],
        ['node', [`--print=${kill}`]],
        ['node', ['--no-warnings', '-p', kill]],
        ['node', ['-p', 'process.kill(someVar)']], // PID not extractable → still blocked
        ['node', ['-p', 'process.kill(process.pid)']],
        ['bun', ['-p', kill]],
        ['bun', ['--print', kill]],
        ['bun', [`--eval=${kill}`]],
        ['/usr/bin/node', ['-p', kill]],
      ])('%s %j → blocked', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(true);
      });

      it.each([
        ['node', ['-p', '1+1']],
        ['node', ['--print', '"process is fine"']],
        ['node', ['-pe', '2']],
        ['node', ['--eval=console.log(1)']],
        ['node', ['-e', 'console.log(1)']],
        ['node', ['script.js']],
        ['node', ['-r', 'dotenv/config', 'app.js']],
        // after a bare `--` the words belong to the script, not the runtime
        ['node', ['app.js', '--', '-p', 'process.kill(1)']],
        ['bun', ['run', 'app.ts']],
      ])('%s %j → allowed (no eval-kill)', async (cmd, args) => {
        expect((await checkExecKillCommand(cmd, args)).blocked).toBe(false);
      });

      it('keeps the unextractable-PID reason', async () => {
        const r = await checkExecKillCommand('node', ['--print=process.kill(someVar)']);
        expect(r.blocked).toBe(true);
        expect(r.reason).toMatch(/process\.kill/);
      });
    });

    it('blocks node -e process.kill() even when PID not extractable', async () => {
      const result = await checkExecKillCommand('node', ['-e', 'process.kill(someVar)']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/process\.kill/);
    });
  });

  // ── POSIX-only tests ─────────────────────────────────────────────────
  describe.runIf(!isWin)('POSIX kill variants', () => {
    it('blocks kill -9 targeting current process PID', async () => {
      const result = await checkExecKillCommand('kill', ['-9', String(process.pid)]);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/current WrongStack/i);
    });

    it('blocks kill targeting current process PID (no signal)', async () => {
      const result = await checkExecKillCommand('kill', [String(process.pid)]);
      expect(result.blocked).toBe(true);
    });

    it('blocks kill with negative group PID', async () => {
      const result = await checkExecKillCommand('kill', ['--', `-${process.pid}`]);
      expect(result.blocked).toBe(true);
    });

    it('blocks pkill node', async () => {
      const result = await checkExecKillCommand('pkill', ['node']);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/node/);
    });

    it('blocks killall node', async () => {
      const result = await checkExecKillCommand('killall', ['node']);
      expect(result.blocked).toBe(true);
    });
  });

  // ── Cross-platform: safe command should pass ─────────────────────────
  describe('safe commands', () => {
    it('allows non-kill commands', async () => {
      const result = await checkExecKillCommand('echo', ['hello']);
      expect(result.blocked).toBe(false);
    });

    it('allows taskkill to unknown PID (non-Windows still safe)', async () => {
      const result = await checkExecKillCommand('taskkill', ['/F', '/PID', '99999999']);
      expect(result.blocked).toBe(false);
    });
  });

  /**
   * `pkill`/`killall` are POSIX name-kill verbs, but exec can run them through
   * Git Bash/WSL on Windows and the guard documents coverage for both. Sending
   * every Windows command to the Windows branch left the name unresolved, so
   * `pkill -9 <runtime>` was allowed. Mirrors the Layer-1 gate.
   */
  describe('POSIX name-kill verbs on every host', () => {
    // Resolved INSIDE each test: this file's beforeEach re-points
    // process.execPath at node.exe, so a collection-time value names a
    // different binary than the guard sees when it runs.
    const currentImage = () =>
      (process.execPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');

    it('blocks pkill and killall that select this runtime', async () => {
      expect((await checkExecKillCommand('pkill', ['-9', currentImage()])).blocked).toBe(true);
      expect((await checkExecKillCommand('killall', ['-9', currentImage()])).blocked).toBe(true);
    });

    it('keeps an unrelated POSIX name kill allowed', async () => {
      expect((await checkExecKillCommand('killall', ['-9', 'some-other-daemon'])).blocked).toBe(
        false,
      );
    });
  });

  describe('piped process-object method invocation', () => {
    const currentImage = () =>
      (process.execPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');

    it('blocks %/ForEach-Object/foreach { $_.Kill() } on the piped runtime', async () => {
      for (const verb of ['%', 'ForEach-Object', 'foreach']) {
        const command = `Get-Process ${currentImage()} | ${verb} { $_.Kill() }`;
        expect((await checkExecKillCommand('pwsh', ['-Command', command])).blocked, command).toBe(
          true,
        );
      }
    });

    it('still allows a read-only pipeline', async () => {
      expect(
        (await checkExecKillCommand('pwsh', ['-Command', 'Get-Process | Select-Object -First 1']))
          .blocked,
      ).toBe(false);
    });
  });
});
