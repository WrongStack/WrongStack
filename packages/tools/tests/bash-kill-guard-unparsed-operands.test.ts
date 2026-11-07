import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A POSIX `kill` signals every numeric operand and only reports the rest as
 * errors, so `kill -9 <pid> junk` kills <pid>. Such a form does not parse (the
 * parser keeps non-PID forms unparsed), and the guard used to let it through —
 * a trailing `/usr/bin/pwsh -c …` additionally sent it to the PowerShell
 * parser, because the launcher pattern matched a pwsh path anywhere.
 */

const { PROTECTED_PID } = vi.hoisted(() => ({ PROTECTED_PID: 424_242 }));

vi.mock('../src/process-registry-persistent.js', () => ({
  // The guard's host filter is exercised by bash-kill-guard-foreign-host; here
  // the fixtures are host-less, so every entry counts as local.
  isEntryFromThisHost: () => true,
  getPersistentProcessRegistry: () => ({
    shouldBlockKill: async (pid: number) => pid === PROTECTED_PID,
    getAllProtectedPids: async () => [PROTECTED_PID],
    getGlobalStatus: async () => ({
      instances: new Map([
        [
          'instance-1',
          [
            {
              pid: PROTECTED_PID,
              name: 'wrongstack-daemon',
              protected: true,
              lastHeartbeat: Date.now(),
            },
          ],
        ],
      ]),
    }),
  }),
}));

async function loadGuard() {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const patched = { ...actual, platform: () => 'linux' };
    return { ...patched, default: patched };
  });
  return import('../src/bash-kill-guard.js');
}

afterEach(() => {
  vi.doUnmock('node:os');
});

describe('bash-kill-guard — unparsed POSIX kill operands', () => {
  it.each([
    `kill -9 ${PROTECTED_PID} abc`,
    `kill -9 ${PROTECTED_PID} /usr/bin/pwsh -c Get-Date`,
    `kill ${PROTECTED_PID} x/pwsh -c Get-Date`,
    `true; kill -9 ${PROTECTED_PID} junk`,
  ])('blocks %j', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  it.each(['kill -9 111 abc', 'kill %1', 'kill $PID', 'kill -l'])(
    'does not block %j',
    async (command) => {
      const { checkAndBlockKillCommand } = await loadGuard();
      expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
    },
  );

  // The junk form must get the plain form's verdict: process groups and -1
  // included, and a PID the shell unquotes.
  it.each([
    [`kill -9 -${PROTECTED_PID}`, `kill -9 -${PROTECTED_PID} abc`],
    ['kill -9 -1', 'kill -9 -1 abc'],
    ['kill -- -1', 'kill -- -1 abc'],
    [`kill -9 ${PROTECTED_PID}`, `kill -9 "${PROTECTED_PID}" abc`],
    [`kill -9 ${PROTECTED_PID}`, `kill -9 '${PROTECTED_PID}' abc`],
    [`kill -9 ${PROTECTED_PID}`, `kill -9 \\${PROTECTED_PID} abc`],
  ])('%j and %j get one verdict', async (plain, junk) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const expected = (await checkAndBlockKillCommand(plain)).blocked;
    expect((await checkAndBlockKillCommand(junk)).blocked).toBe(expected);
  });

  it.each([`kill -9 "${PROTECTED_PID}"`, `kill '${PROTECTED_PID}'`, `kill \\${PROTECTED_PID}`])(
    'blocks the quoted PID %j',
    async (command) => {
      const { checkAndBlockKillCommand } = await loadGuard();
      expect((await checkAndBlockKillCommand(command)).blocked).toBe(true);
    },
  );

  it.each([
    `ionice /usr/bin/pwsh -c Stop-Process -Id ${PROTECTED_PID}`,
    `ionice -c 3 pwsh -c Stop-Process -Id ${PROTECTED_PID}`,
    `taskset 1 /usr/bin/pwsh -c Stop-Process -Id ${PROTECTED_PID}`,
    `chrt 1 /usr/bin/pwsh -c Stop-Process -Id ${PROTECTED_PID}`,
    `taskset 0x3 kill -9 ${PROTECTED_PID}`,
  ])('blocks a kill behind a scheduling wrapper: %j', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(true);
  });

  // The reason must name the protected PID: an earlier version blocked some of
  // these for a wrong reason (reading `-9` as process group 9).
  it.each([
    `kill -9 4"24242"`,
    `kill -9 "424"242`,
    `kill -9 '42'"42"42`,
    `kill -9 4\\24242`,
    `kill -9 4"24242" abc`,
    `kill -9 ${PROTECTED_PID} abc --`,
    `kill -9 abc -- ${PROTECTED_PID}`,
    `kill abc -9 ${PROTECTED_PID}`,
    `ionice -t kill -9 ${PROTECTED_PID}`,
    `ionice --class 3 kill -9 ${PROTECTED_PID}`,
    `ionice --class=3 kill -9 ${PROTECTED_PID}`,
    `chrt --sched-runtime 5 1 kill -9 ${PROTECTED_PID}`,
    `nice --adjustment 5 kill -9 ${PROTECTED_PID}`,
    `timeout --signal KILL 5 kill -9 ${PROTECTED_PID}`,
  ])('blocks %j naming the protected PID', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  // A shell runs the words after a quoted -c payload as $0, $1 …; a launcher
  // reading that stops on the wrong word must not hide the payload either.
  it.each([
    `sh -c 'kill -9 ${PROTECTED_PID}' kill`,
    `nice sh -c 'kill -9 ${PROTECTED_PID}' kill`,
    `nice bash -c "kill -9 ${PROTECTED_PID}" kill`,
    `timeout 5 sh -c 'kill -9 ${PROTECTED_PID}' name arg`,
    `kill -9 +${PROTECTED_PID}`,
    `kill -9 +${PROTECTED_PID} abc`,
    `kill -9 $'${PROTECTED_PID}'`,
    `kill -9 $'\\x34\\x32\\x34\\x32\\x34\\x32'`,
    `kill -9 $'\\064\\062\\064\\062\\064\\062'`,
    `kill -9 $"${PROTECTED_PID}"`,
  ])('blocks %j naming the protected PID (shell payloads and numbers)', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  // The -c payload is one shell word however it is quoted, and a sequenced
  // payload is read command by command — behind a launcher or not.
  it.each([
    `sh -c 'kill -9 '"${PROTECTED_PID}"`,
    `sh -c 'kill -9 '${PROTECTED_PID}`,
    `sh -c kill\\ -9\\ ${PROTECTED_PID}`,
    `sh -c $'kill -9 ${PROTECTED_PID}'`,
    `sh -c "kill -9 ${PROTECTED_PID}"'' x`,
    `bash -lc 'kill -9 ${PROTECTED_PID}'`,
    `sh -c 'true; kill -9 ${PROTECTED_PID}'`,
    `nice --adjustment 5 sh -c 'true; kill -9 ${PROTECTED_PID}'`,
    `timeout --signal KILL 5 bash -c 'echo; kill -9 ${PROTECTED_PID}'`,
    `nice --adjustment 5 true; kill -9 ${PROTECTED_PID}`,
    `kill -9 $'\\u0034'24242`,
  ])('blocks %j naming the protected PID (-c words and sequences)', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  it('decodes \\u with at most four hex digits, as bash does', async () => {
    const { unquoteShellWord } = await import('../src/bash-kill-detect.js');
    expect(unquoteShellWord("$'\\u00341'")).toBe('41');
  });

  // The words after a -c payload are its $0, $1 …; measured in bash:
  // `sh -c '$0 -9 $1' kill <pid>` kills <pid>.
  it.each([
    `sh -c '$0 -9 $1' kill ${PROTECTED_PID}`,
    `sh -c '"$@"' x kill -9 ${PROTECTED_PID}`,
    `bash -c '$1 -9 $2' _ kill ${PROTECTED_PID}`,
    `sh -c '\${1} -9 \${2}' _ kill ${PROTECTED_PID}`,
    `sh -c 'exec "$@"' sh kill -9 ${PROTECTED_PID}`,
  ])('blocks %j through its positional arguments', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  // The expanded payload is an extra reading: replacing the payload with it
  // unquoted a nested `sh -c '<kill>'` into a bare word that hid the kill.
  it.each([
    `sh -c "sh -c 'kill -9 ${PROTECTED_PID}' \\$1" _ x`,
    `sh -c "sh -c 'kill -9 ${PROTECTED_PID}'; echo \\$1" _ x`,
    `bash -c "eval 'kill -9 ${PROTECTED_PID}' \\$0" y`,
    `eval 'kill -9 ${PROTECTED_PID}'`,
  ])('blocks %j (payload kept beside its expansion; eval bodies)', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(String(PROTECTED_PID));
  });

  it('refuses rather than allows a kill left unchecked when the work runs out', async () => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const kill = `sh -c '${'true; '.repeat(300)}kill -9 ${PROTECTED_PID}'`;
    expect((await checkAndBlockKillCommand(kill)).blocked).toBe(true);
    const harmless = `sh -c '${'true; '.repeat(300)}echo done'`;
    expect((await checkAndBlockKillCommand(harmless)).blocked).toBe(false);
  });

  it('allows a deep launcher chain ending in an unprotected kill', async () => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand('sudo nice timeout 5 nohup setsid kill 111');
    expect(result).toEqual({ blocked: false });
  });

  it('settles a long chain of launchers quickly', async () => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const chain = `${'nice '.repeat(40)}kill -9 ${PROTECTED_PID}`;
    const started = Date.now();
    expect((await checkAndBlockKillCommand(chain)).blocked).toBe(true);
    expect((await checkAndBlockKillCommand(`${'nice '.repeat(40)}make`)).blocked).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads a negative operand after a junk word as a process group', async () => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(`kill abc -${PROTECTED_PID} 1`);
    expect(result.blocked).toBe(true);
  });

  // The fail-closed backstop: a protected PID in any decoded word next to
  // anything kill-shaped is refused, however the line is spelled — including
  // the guard's own documented static-parse bypasses.
  it.each([
    `ki''ll -9 ${PROTECTED_PID}`,
    `k"i"ll ${PROTECTED_PID}`,
    `$(printf kill) -9 ${PROTECTED_PID}`,
    `eval "ki""ll -9 ${PROTECTED_PID}"`,
    `node -e "process.kill(${PROTECTED_PID})"`,
    `python3 -c "import os; os.kill(${PROTECTED_PID}, 9)"`,
    `sh -c '$0 "$1" $2' kill "'" ${PROTECTED_PID}`,
    `echo kill ${PROTECTED_PID}`,
    `kill -s SIGKILL $'\\x34\\x32\\x34\\x32\\x34\\x32'`,
  ])('refuses %j through the protected-PID backstop', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/protected WrongStack process/);
  });

  // The backstop re-reads from each kill verb with quoting removed (group, all
  // and name rules apply), checks every number with no cap, and treats a
  // command built at run time like a kill word.
  it('finds the protected PID behind any number of other numbers', async () => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const pad = Array.from({ length: 70 }, (_, i) => String(1000 + i)).join(' ');
    const result = await checkAndBlockKillCommand(`ki''ll -9 ${pad} ${PROTECTED_PID}`);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/protected WrongStack process/);
  });

  it.each([
    `ki''ll -9 -1`,
    `ki''ll -- -1`,
    `k"i"ll -9 -${PROTECTED_PID}`,
    `pk''ill wrongstack`,
    `ki''llall node`,
    `$(printf '\\153\\151\\154\\154') -9 ${PROTECTED_PID}`,
    `\`printf kil\`l -9 ${PROTECTED_PID}`,
    `echo -9 ${PROTECTED_PID} | xargs $(echo k)ill`,
  ])('refuses %j (group/all/name kills, commands built at run time)', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/protected WrongStack process/);
  });

  it.each([
    'kill -9 123',
    'kill -1 123',
    'echo $(date) done',
    'pkill -f my-dev-server',
    `sh -c 'echo ${PROTECTED_PID}'`,
  ])('allows %j', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
  });

  // Reading a protected process is not killing it.
  it.each([
    `ps -p ${PROTECTED_PID}`,
    `cat /proc/${PROTECTED_PID}/status`,
    `echo ${PROTECTED_PID}`,
    `lsof -p ${PROTECTED_PID}`,
  ])('allows %j: a protected PID without a kill', async (command) => {
    const { checkAndBlockKillCommand } = await loadGuard();
    expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
  });

  it.each(['kill -9 111 abc', 'ionice -c 3 make', 'echo kill 111'])(
    'still allows %j',
    async (command) => {
      const { checkAndBlockKillCommand } = await loadGuard();
      expect((await checkAndBlockKillCommand(command)).blocked).toBe(false);
    },
  );
});

describe('stripPowerShellLauncherHead — the launcher is the first token', () => {
  it.each(['kill -9 1234 /usr/bin/pwsh -c Get-Date', 'echo x/pwsh -c Stop-Process -Id 1'])(
    'finds no launcher in %j',
    async (command) => {
      const { stripPowerShellLauncherHead } = await import('../src/bash-kill-detect.js');
      expect(stripPowerShellLauncherHead(command)).toBeNull();
    },
  );

  it.each([
    'pwsh -c Stop-Process -Id 1234',
    '/usr/bin/pwsh -c Stop-Process -Id 1234',
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c Stop-Process -Id 1234',
    "& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -c Stop-Process -Id 1234",
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile Stop-Process -Id 1234',
  ])('strips %j', async (command) => {
    const { stripPowerShellLauncherHead } = await import('../src/bash-kill-detect.js');
    expect(stripPowerShellLauncherHead(command)).toBe('Stop-Process -Id 1234');
  });
});
