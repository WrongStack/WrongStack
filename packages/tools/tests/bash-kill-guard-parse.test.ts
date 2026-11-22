/**
 * Additional coverage for bash-kill-guard.ts — parseKillCommand branch
 * coverage for taskkill, Stop-Process, kill, and kill-script patterns.
 * Platform-aware: pkill/killall are POSIX-only, wmic patterns vary.
 */
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseKillCommand } from '../src/bash-kill-guard.js';
import { parseWindowsKillCommand } from '../src/bash-kill-parse-windows.js';

const isWin = os.platform() === 'win32';

describe('parseKillCommand', () => {
  // ── taskkill (Windows) ─────────────────────────────────────────────────

  // taskkill is Windows-only
  it.runIf(isWin)('parses taskkill /PID with /F', () => {
    const result = parseKillCommand('taskkill /PID 1234 /F');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // taskkill is Windows-only
  it.runIf(isWin)('parses taskkill /IM by image name', () => {
    const result = parseKillCommand('taskkill /IM node.exe /F');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('node.exe');
  });

  // taskkill binds the colon-attached value form identically (live-verified
  // 2026-09-29: `/IM:<missing>.exe` → exit 128 "process not found" — the
  // syntax is accepted and the lookup performed), mirroring the Stop-Process
  // colon-attached family below.
  it.runIf(isWin)('parses taskkill /PID:<pid> colon-attached', () => {
    const result = parseKillCommand('taskkill /PID:4242');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(4242);
  });

  // taskkill is Windows-only
  it.runIf(isWin)('parses taskkill /F /IM:<image> colon-attached', () => {
    const result = parseKillCommand('taskkill /F /IM:node.exe');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('node.exe');
  });

  // A redirection only discards output; it does not name a different process.
  // The simple-taskkill gate rejected any `<`/`>`, so the target was never
  // parsed and `taskkill /F /IM x > nul` was allowed while the same command
  // without redirection was blocked. Parsed directly so this runs everywhere.
  describe('taskkill with IO redirection names the same target', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      'taskkill /F /IM node.exe > nul',
      'taskkill /F /IM node.exe 2>nul',
      'taskkill /F /IM node.exe >nul 2>&1',
      'taskkill /F /IM node.exe >> log.txt',
      'taskkill /F /IM node.exe < nul',
    ])('%s → name node.exe', (line) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.name).toBe('node.exe');
    });

    it.each([
      ['taskkill /F /PID 4242 > nul', 4242],
      ['taskkill /F /PID 4242 2>nul', 4242],
      ['taskkill /F /FI "PID eq 4242" > nul', 4242],
    ])('%s → pid %i', (line, pid) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.pid).toBe(pid);
    });

    it('leaves sequencing and pipelines on the conservative path', () => {
      expect(parse('taskkill /F /IM node.exe | findstr x')).toBeNull();
      expect(parse('taskkill /F /IM node.exe & echo hi')).toBeNull();
    });
  });

  // ── tskill ─────────────────────────────────────────────────────────────

  // tskill is Windows-only
  it.runIf(isWin)('parses tskill with PID', () => {
    const result = parseKillCommand('tskill 5678');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(5678);
  });

  // ── Stop-Process (PowerShell) ──────────────────────────────────────────

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses Stop-Process -Id', () => {
    const result = parseKillCommand('Stop-Process -Id 1234 -Force');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses Stop-Process -Id:<pid> colon-attached', () => {
    const result = parseKillCommand('Stop-Process -Id:1234 -Force');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses kill -Id:<pid> colon-attached alias', () => {
    const result = parseKillCommand('kill -Id:1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses Stop-Process -id:<pid> colon-attached lowercase', () => {
    const result = parseKillCommand('Stop-Process -id:1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses Stop-Process -Name:<name> colon-attached', () => {
    const result = parseKillCommand('Stop-Process -Name:chrome -Force');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('chrome');
  });

  // PowerShell binds a QUOTED string to a typed parameter: `-Id:'1234'`,
  // `-Id "1234"` and `-Name:'node'` terminate exactly like the bare forms
  // (live-verified against a sacrificial process). The parsers matched only
  // bare values, so the quoted spelling produced no target and was allowed.
  // Tested on the Windows parser directly so it runs on every host.
  describe('quoted Stop-Process parameter values', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      "Stop-Process -Id:'4242'",
      'Stop-Process -Id:"4242"',
      "Stop-Process -Id '4242'",
      'Stop-Process -Id "4242"',
      "Stop-Process -Id:'4242' -Force",
    ])('%s → pid 4242', (line) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.pid).toBe(4242);
    });

    it.each([
      "Stop-Process -Name:'node.exe'",
      'Stop-Process -Name:"node.exe"',
      "spps -Name:'node'",
      'kill -Name:"node"',
    ])('%s → name node', (line) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.name).toMatch(/^node(?:\.exe)?$/);
    });
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses powershell-wrapped Stop-Process -Id (implicit -Command)', () => {
    const result = parseKillCommand('powershell Stop-Process -Id 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses powershell-wrapped Stop-Process with launcher flags', () => {
    const result = parseKillCommand(
      'powershell -NoProfile -ExecutionPolicy Bypass Stop-Process -Id 1234',
    );
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses powershell -command with unquoted payload', () => {
    const result = parseKillCommand('powershell -command stop-process -id 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses powershell -command with quoted payload', () => {
    const result = parseKillCommand('powershell -command "stop-process -id 1234"');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses powershell taskkill wrapper', () => {
    const result = parseKillCommand('powershell taskkill /F /PID 1234');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('FORCE');
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('does not parse a powershell -File script as a kill command', () => {
    expect(parseKillCommand('powershell -File kill-things.ps1')).toBeNull();
  });

  // Stop-Process is Windows-only
  it.runIf(isWin)('parses Stop-Process -Name with process name', () => {
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

  // pkill is POSIX-only
  it.skipIf(isWin)('parses pkill on POSIX', () => {
    const result = parseKillCommand('pkill node');
    // `not.toBeNull()` alone passed a parser that named the WRONG process — for
    // a guard deciding whether a kill targets WrongStack, the target is the
    // whole point. Values follow the parser's own capture (`pkill <name>`).
    expect(result).toMatchObject({ name: 'node', signal: 'TERM', isAllKill: false });
  });

  // killall is POSIX-only
  it.skipIf(isWin)('parses killall on POSIX', () => {
    const result = parseKillCommand('killall node');
    // `not.toBeNull()` alone passed a parser that named the WRONG process — for
    // a guard deciding whether a kill targets WrongStack, the target is the
    // whole point. Values follow the parser's own capture (`killall <name>`).
    expect(result).toMatchObject({ name: 'node', signal: 'TERM', isAllKill: false });
  });

  // ── kill scripts ───────────────────────────────────────────────────────

  // .ps1 scripts are Windows-only
  it.runIf(isWin)('parses kill script (.ps1)', () => {
    const result = parseKillCommand('kill-process.ps1 -pid 1234');
    expect(result?.name).toBe('kill-script');
  });

  it('parses kill script (.sh)', () => {
    const result = parseKillCommand('./kill-server.sh');
    expect(result?.name).toBe('kill-script');
  });

  // .bat scripts are Windows-only
  it.runIf(isWin)('parses kill script (.bat)', () => {
    const result = parseKillCommand('terminate-all.bat');
    expect(result?.name).toBe('kill-script');
  });

  // .cmd scripts are Windows-only
  it.runIf(isWin)('parses kill script (.cmd)', () => {
    const result = parseKillCommand('stop-services.cmd');
    expect(result?.name).toBe('kill-script');
  });

  // Negative control for the kill-script branch. Recognition is by NAME, so an
  // ordinary script must NOT be classified as a kill — otherwise the guard
  // would block routine `./build.sh` / `deploy.ps1` runs. Every test above
  // asserted only non-null, which could not tell over-matching from matching.
  it.each([['build.sh'], ['./deploy.ps1'], ['setup.bat'], ['test-runner.cmd']])(
    'does not classify ordinary script %j as a kill script',
    (cmd) => {
      expect(parseKillCommand(cmd)?.name).not.toBe('kill-script');
    },
  );

  // ── wmic (Windows) ──────────────────────────────────────────────────

  // wmic is Windows-only
  it.runIf(isWin)('parses wmic process where "name=..." delete', () => {
    const result = parseKillCommand('wmic process where "name=\'node.exe\'" delete');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('node.exe');
  });

  // wmic is Windows-only
  it.runIf(isWin)('parses wmic process where "ProcessId=N" delete (issue #360)', () => {
    const result = parseKillCommand('wmic process where "ProcessId=1234" delete');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.signal).toBe('FORCE');
  });

  // wmic is Windows-only
  it.runIf(isWin)('parses unquoted wmic ProcessId form (issue #360)', () => {
    const result = parseKillCommand('wmic process where ProcessId=1234 delete');
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  // ── wmic `call terminate` (platform-independent parser) ────────────────
  // `... call terminate` is the WMIC method spelling of `... delete`: both
  // terminate the matched process. The detector gated on `delete` alone, so
  // the method spelling never reached any of the target branches below.
  describe('wmic call terminate names the same target as delete', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      ['wmic process where processid=4242 call terminate', 4242],
      ['wmic process where ProcessId=4242 Call Terminate', 4242],
      ['wmic process where "ProcessId=4242" call terminate', 4242],
    ])('%s → pid %i', (line, pid) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.pid).toBe(pid);
      expect(r!.signal).toBe('FORCE');
    });

    it('reads the name filter in the method spelling', () => {
      expect(parse("wmic process where name='node.exe' call terminate")?.name).toBe('node.exe');
      expect(parse('wmic process where "name=\'node.exe\'" Call Terminate')?.name).toBe('node.exe');
    });
  });

  // ── taskkill /FI "PID eq <n>" (platform-independent parser) ────────────
  // `taskkill /FI "PID eq <n>"` terminates <n> like `/PID <n>` (live-verified),
  // but only the IMAGENAME filter was parsed, so the bash guard saw no target at
  // all. Tested on the Windows parser directly so it runs on every host.
  describe('taskkill /FI "PID eq <n>" names a PID', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      ['taskkill /F /FI "PID eq 4242"', 4242],
      ['taskkill /F /FI "pid eq 4242"', 4242],
      ['taskkill /F /FI "PID EQ 4242"', 4242],
      ['taskkill /FI "PID eq 4242" /F', 4242],
      ['taskkill /F /FI "PID  eq  4242"', 4242],
      ['taskkill /F /T /FI "PID eq 4242"', 4242],
    ])('%s → pid %i', (line, pid) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.pid).toBe(pid);
      expect(r!.signal).toBe(/\/F\b/i.test(line) ? 'FORCE' : 'TERM');
    });

    it('collects every PID when /PID and /FI are mixed', () => {
      const r = parse('taskkill /PID 111 /FI "PID eq 222"');
      expect(r!.pid).toBe(111);
      expect(r!.pids).toEqual([111, 222]);
    });

    it.each([
      'taskkill /F /FI "STATUS eq RUNNING"',
      'taskkill /F /FI "PID eq notanumber"',
      'taskkill /F /FI "PID gt 100"',
    ])('%s → no PID target', (line) => {
      expect(parse(line)?.pid).toBeUndefined();
    });

    it('still reads the IMAGENAME filter and the plain /PID form', () => {
      expect(parse('taskkill /F /FI "IMAGENAME eq node.exe"')?.name).toBe('node.exe');
      expect(parse('taskkill /F /PID 4242')?.pid).toBe(4242);
    });
  });

  // ── taskkill /FI "PID <op> <n>" range filters (platform-independent) ───
  // `taskkill /F /FI "PID ge 1"` force-kills a PID SET. Only `eq` was read,
  // so every inequality spelling parsed to no target at all and the guard
  // allowed a kill that reaches this runtime.
  describe('taskkill /FI "PID <op> <n>" names a PID set', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      ['taskkill /F /FI "PID ge 1"', 'ge'],
      ['taskkill /F /FI "PID gt 1"', 'gt'],
      ['taskkill /F /FI "PID le 1"', 'le'],
      ['taskkill /F /FI "PID lt 1"', 'lt'],
      ['taskkill /F /FI "PID ne 1"', 'ne'],
      ['taskkill /F /FI "pid NE 1"', 'ne'],
      ['taskkill /FI "PID  ge  1" /F', 'ge'],
    ])('%s → %s filter, no single PID', (line, op) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.pid).toBeUndefined();
      expect(r!.pids).toBeUndefined();
      expect(r!.pidFilters).toEqual([{ op, value: 1 }]);
      expect(r!.signal).toBe(/\/F\b/i.test(line) ? 'FORCE' : 'TERM');
    });

    it('keeps an eq filter a single PID, not a range', () => {
      const r = parse('taskkill /F /FI "PID eq 4242"');
      expect(r!.pid).toBe(4242);
      expect(r!.pidFilters).toBeUndefined();
    });

    it('carries a /PID flag and range clauses together', () => {
      const r = parse('taskkill /PID 111 /FI "PID ge 5" /FI "PID lt 9"');
      expect(r!.pid).toBe(111);
      expect(r!.pids).toBeUndefined();
      expect(r!.pidFilters).toEqual([
        { op: 'ge', value: 5 },
        { op: 'lt', value: 9 },
      ]);
    });
  });

  // ── tskill <process name> (platform-independent parser) ────────────────
  // `tskill <name>` kills every process with that image name (live-verified on a
  // renamed copy of ping); `/A` and `/V` are switches on either side of it. Only
  // `tskill <pid>` was parsed, so a name target had no entry in the guard at all.
  describe('tskill <process name> names a process', () => {
    const parse = (line: string) => parseWindowsKillCommand(line, line.replace(/\s+/g, ' ').trim());

    it.each([
      ['tskill node', 'node'],
      ['tskill NODE', 'NODE'],
      ['tskill wrongstack', 'wrongstack'],
      ['tskill /A node', 'node'],
      ['tskill node /A', 'node'],
      ['tskill node /V', 'node'],
      ['tskill /A /V node', 'node'],
      ['tskill "node"', 'node'],
      ['tskill.exe node', 'node'],
    ])('%s → name %s', (line, name) => {
      const r = parse(line);
      expect(r).not.toBeNull();
      expect(r!.name).toBe(name);
      expect(r!.pid).toBeUndefined();
      expect(r!.signal).toBe('TERM');
    });

    it.each(['tskill /?', 'tskill /A', 'tskill /A /V', 'tskill'])('%s → no name target', (line) => {
      const r = parse(line);
      expect(r === null || r.name === undefined).toBe(true);
    });

    it('still prefers the numeric PID form', () => {
      const r = parse('tskill 5678');
      expect(r!.pid).toBe(5678);
      expect(r!.name).toBeUndefined();
    });
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

/**
 * `killall`/`pkill` are POSIX name-kill verbs, but a bash tool can run them
 * through Git Bash/WSL on a Windows host and the guard documents coverage for
 * both. Routing every Windows command to the Windows parser left the name
 * unresolved, so `killall -9 <runtime>` was allowed on win32.
 */
describe('POSIX name-kill verbs are evaluated on every host', () => {
  const image = (process.execPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  const guard = () => import('../src/bash-kill-guard.js').then((m) => m.checkAndBlockKillCommand);

  it('blocks killall and pkill that select this runtime', async () => {
    expect((await (await guard())(`killall -9 ${image}`)).blocked).toBe(true);
    expect((await (await guard())(`pkill -9 -f ${image}`)).blocked).toBe(true);
  });

  // Piped process-object method invocation names no kill VERB, so this layer
  // found no kill command and allowed `Get-Process <runtime> | % { $_.Kill() }`,
  // which terminates every process the pipe carries. Resolved INSIDE the test:
  // a collection-time image would name a different binary than the guard sees.
  it('blocks %/ForEach-Object/foreach { $_.Kill() } on the piped runtime', async () => {
    const runtimeImage = (process.execPath.split(/[\\/]/).pop() ?? '')
      .toLowerCase()
      .replace(/\.exe$/, '');
    for (const verb of ['%', 'ForEach-Object', 'foreach']) {
      const command = `Get-Process ${runtimeImage} | ${verb} { $_.Kill() }`;
      expect((await (await guard())(command)).blocked, command).toBe(true);
    }
  });

  it('keeps an unrelated POSIX name kill allowed', async () => {
    expect((await (await guard())('killall -9 some-other-daemon')).blocked).toBe(false);
  });
});
