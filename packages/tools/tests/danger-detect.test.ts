import { describe, expect, it } from 'vitest';
import {
  COMMAND_STRING_FLAGS,
  HALT_LAUNCHER_VALUE_FLAGS,
} from '../../core/src/security/yolo-risk.js';
import { ARGV_LAUNCHERS, detectDanger, unwrapArgvLaunchers } from '../src/_danger-detect.js';

describe('transparent launchers do not hide the real command', () => {
  // Probe-verified gap (2026-09-22): `exec` receives ARGV, so a launcher is
  // the executable and the real command is its first operand -- and `env`,
  // `nice`, `nohup` and `timeout` all ship in the DEFAULT exec allowlist.
  // Every rule keys on `cmd`, so `exec nohup rm -rf /` assessed as `safe`.
  // 10 of 12 launcher-wrapped forms were missed.
  //
  // Scope, honestly: this level drives the destructive-command BANNER, not the
  // permission gate. `destructiveKindOf` joins cmd+args into a shell line and
  // classifies `nohup rm -rf /` on its own, so the confirmation still happened
  // -- the warning that explains WHY did not.
  it.each([
    ['nohup', 'nohup', ['rm', '-rf', '/']],
    ['nice', 'nice', ['rm', '-rf', '/']],
    ['nice with option', 'nice', ['-n', '5', 'rm', '-rf', '/']],
    ['env', 'env', ['rm', '-rf', '/']],
    ['env -i', 'env', ['-i', 'rm', '-rf', '/']],
    ['env with assignment', 'env', ['FOO=1', 'rm', '-rf', '/']],
    ['timeout with operand', 'timeout', ['5', 'rm', '-rf', '/']],
    ['timeout with signal', 'timeout', ['-s', 'KILL', '5', 'rm', '-rf', '/']],
    ['sudo', 'sudo', ['rm', '-rf', '/']],
    ['nested launchers', 'nohup', ['nice', 'rm', '-rf', '/']],
    ['after --', 'env', ['--', 'rm', '-rf', '/']],
    ['path-qualified launcher', '/usr/bin/nohup', ['rm', '-rf', '/']],
  ])('sees the destructive command behind %s', (_name, cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('destructive');
  });

  it('still reports a launcher wrapping a force push', () => {
    expect(detectDanger('nohup', ['git', 'push', '--force']).matchedRule).toBe('git-push-force');
  });

  // `timeout`'s own positional is a DURATION: coreutils defines it as "a
  // floating point number in either the current or the C locale … followed by
  // an optional unit", parsed with strtod/strtold — so `0.5s`, `1.5` and `2.5m`
  // are the same shape as `5`, and the manual's `Floating point` node adds
  // scientific notation (`1.0e-34`, `-10e100`) and hexadecimal floating point
  // (`-0x.ep-3`). Matching only the integer spelling did not merely skip the
  // unwrap: the duration was taken FOR the command
  // (`{ cmd: '0.5s', args: ['rm', …] }`), so the wrapped `rm -rf` never reached
  // the cmd-keyed rules and this identical delete reported `safe` while
  // `timeout 5 rm -rf ./build` reported `destructive`.
  it.each([
    ['fractional seconds', '0.5s'],
    ['fractional, no suffix', '1.5'],
    ['fractional minutes', '2.5m'],
    ['scientific notation', '1e3'],
    ['scientific notation, signed exponent', '1e+3'],
    ['negative exponent', '1.5e-2'],
    ['uppercase exponent', '2E4'],
    ['hexadecimal float', '0x1p3'],
  ])('unwraps a %s duration to the real command', (_name, duration) => {
    expect(unwrapArgvLaunchers('timeout', [duration, 'rm', '-rf', './build'])).toEqual({
      cmd: 'rm',
      args: ['-rf', './build'],
    });
  });

  it.each([
    ['0.5s', ['0.5s', 'rm', '-rf', './build']],
    ['1.5', ['1.5', 'rm', '-rf', './build']],
    ['2.5m', ['2.5m', 'rm', '-rf', '/']],
    ['0.5s after an option', ['--foreground', '0.5s', 'rm', '-rf', './build']],
    ['1e3', ['1e3', 'rm', '-rf', '/']],
    ['2E4', ['2E4', 'rm', '-rf', './build']],
    ['0x1p3', ['0x1p3', 'rm', '-rf', './build']],
  ])('sees the destructive command behind a %s duration', (_name, args) => {
    expect(detectDanger('timeout', args).level).toBe('destructive');
  });

  // A launcher's own OPERANDS are not the command. sudo(8) documents -p, -h,
  // -r, -t, -D, -R, -T and -U as value-taking, so their value must be skipped:
  // `sudo -p pw rm -rf ./build` unwrapped to cmd `pw` and reported only
  // 'caution' (the bare-`sudo` rule) instead of 'destructive'. `env -S
  // "<command line>"` is stronger still — its VALUE is a command line env
  // splits and RUNS, so the whole command had to be expanded before any
  // `cmd`-keyed rule could see it.
  it.each([
    ['sudo -p (prompt)', ['-p', 'pw']],
    ['sudo -h (host)', ['-h', 'host.example']],
    ['sudo -r (role)', ['-r', 'sysadm_r']],
    ['sudo -t (type)', ['-t', 'sysadm_t']],
    ['sudo -D (chdir)', ['-D', '/srv']],
    ['sudo -R (chroot)', ['-R', '/jail']],
    ['sudo -T (command-timeout)', ['-T', '30']],
    ['sudo -U (other-user)', ['-U', 'bob']],
  ])('unwraps through %s to the command it runs', (_name, flagAndValue) => {
    expect(unwrapArgvLaunchers('sudo', [...flagAndValue, 'rm', '-rf', './build'])).toEqual({
      cmd: 'rm',
      args: ['-rf', './build'],
    });
  });

  // Control pair: every value-taking spelling must classify exactly like the
  // canonical form, and a NO-VALUE sudo flag (-n) is pinned too so a future
  // widening cannot start swallowing the command for those.
  it.each([
    ['canonical', []],
    ['-p', ['-p', 'pw']],
    ['-h', ['-h', 'host.example']],
    ['-r', ['-r', 'sysadm_r']],
    ['-t', ['-t', 'sysadm_t']],
    ['-D', ['-D', '/srv']],
    ['-R', ['-R', '/jail']],
    ['-T', ['-T', '30']],
    ['-U', ['-U', 'bob']],
    ['-n (no value)', ['-n']],
  ])('sees the destructive command behind sudo %s', (_name, flagAndValue) => {
    expect(detectDanger('sudo', [...flagAndValue, 'rm', '-rf', './build']).level).toBe(
      'destructive',
    );
  });

  it.each([
    ['separated', ['-S', 'rm -rf ./build']],
    ['glued short', ['-Srm -rf ./build']],
    ['long with equals', ['--split-string=rm -rf ./build']],
    ['after another env flag', ['-i', '-S', 'rm -rf ./build']],
  ])('unwraps env %s split-string to the command it runs', (_name, args) => {
    expect(unwrapArgvLaunchers('env', args)).toEqual({ cmd: 'rm', args: ['-rf', './build'] });
  });

  it.each([
    ['separated', ['-S', 'rm -rf ./build']],
    ['glued short', ['-Srm -rf ./build']],
    ['long with equals', ['--split-string=rm -rf ./build']],
  ])('sees the destructive command behind env %s split-string', (_name, args) => {
    expect(detectDanger('env', args).level).toBe('destructive');
  });

  it.each([
    ['env -S with a benign command', 'env', ['-S', 'pnpm build'], 'safe'],
    ['env -i with a benign command', 'env', ['-i', 'pnpm', 'build'], 'safe'],
    ['sudo -p with a benign command', 'sudo', ['-p', 'pw', 'pnpm', 'build'], 'caution'],
  ])('keeps %s at its canonical level', (_name, cmd, args, expected) => {
    expect(detectDanger(cmd, args).level).toBe(expected);
  });

  // doas(1) is short-option-only and takes a value for -a (authentication
  // style), -C (config file) and -u (user). Modelling only -u/-C made
  // `doas -a pass rm -rf ./build` unwrap to cmd `pass`, hiding the delete; -n,
  // -s and -L take no value, so they must keep unwrapping — a token skipped for
  // one of those would swallow the command itself.
  it.each([
    ['doas -a (authentication style)', ['-a', 'pass']],
    ['doas -C (config file)', ['-C', '/etc/doas.conf']],
    ['doas -u (user)', ['-u', 'root']],
  ])('unwraps through %s to the command it runs', (_name, flagAndValue) => {
    expect(unwrapArgvLaunchers('doas', [...flagAndValue, 'rm', '-rf', './build'])).toEqual({
      cmd: 'rm',
      args: ['-rf', './build'],
    });
  });

  // Control pair: every value-taking spelling classifies exactly like the
  // canonical form, and the no-value flags keep unwrapping.
  it.each([
    ['canonical', []],
    ['-a', ['-a', 'pass']],
    ['-C', ['-C', '/etc/doas.conf']],
    ['-u', ['-u', 'root']],
    ['-n (no value)', ['-n']],
    ['-s (no value)', ['-s']],
    ['-L (no value)', ['-L']],
  ])('sees the destructive command behind doas %s', (_name, flagAndValue) => {
    expect(detectDanger('doas', [...flagAndValue, 'rm', '-rf', './build']).level).toBe(
      'destructive',
    );
  });

  it('keeps a doas -a invocation with a benign command at its canonical caution', () => {
    expect(detectDanger('doas', ['-a', 'pass', 'pnpm', 'build']).level).toBe('caution');
  });

  // Unwrapping must not invent danger: a launcher in front of ordinary work
  // stays safe, and an unrecognised leading token is never dropped.
  it.each([
    ['nohup', ['pnpm', 'build']],
    ['nice', ['-n', '10', 'pnpm', 'test']],
    ['timeout', ['60', 'vitest', 'run']],
    ['timeout', ['1e3', 'vitest', 'run']],
    ['nohup', []],
    ['env', ['-i']],
  ])('stays safe for %s %j', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('safe');
  });

  // The `shell-launcher` rule already flagged launcher-wrapped INTERPRETERS at
  // `caution` ("bypasses allowlist name-gate"). That rule is why this case is
  // not `safe`, and it predates the unwrapping — which is also the measure of
  // what was missing: it recognised the SHAPE of a wrapper, never the severity
  // of what was wrapped, so a launcher in front of `rm -rf /` stayed `safe`.
  it('keeps the pre-existing caution for a launcher wrapping an interpreter', () => {
    const verdict = detectDanger('env', ['FOO=1', 'node', 'scripts/build.mjs']);
    expect(verdict.level).toBe('caution');
    expect(verdict.matchedRule).toBe('shell-launcher');
  });

  it('leaves a non-launcher argv untouched', () => {
    expect(unwrapArgvLaunchers('pnpm', ['build'])).toEqual({ cmd: 'pnpm', args: ['build'] });
  });
});

// Probe-verified gap (2026-09-22): a real invocation ships an interpreter's
// payload as ONE argv string. Every rule matches its flags per-ARG and anchored,
// so nothing inside that string matched and the assessment came back `safe` —
// while the artificially pre-split spelling the tests above used WAS flagged.
// That split shape is not what `exec` receives: a model writing
// `powershell -Command "Remove-Item -Recurse -Force C:\Users\x"` produces
// `['-Command', 'Remove-Item -Recurse -Force C:\\Users\\x']`.
//
// Scope, honestly: the core-side permission gate joins cmd+args into a shell
// line and classified these correctly, so the confirmation still happened — the
// banner that explains WHY did not.
describe('an inline interpreter payload is read as the command it is', () => {
  it.each([
    ['powershell', ['-Command', 'Remove-Item -Recurse -Force C:\\Users\\victim\\Documents']],
    ['pwsh', ['-Command', 'Remove-Item -Recurse -Force ./build']],
    ['powershell', ['-c', 'Remove-Item -Recurse -Force ./build']],
    ['powershell.exe', ['-Command', 'Remove-Item -Recurse -Force ./build']],
    ['pwsh', ['-command', 'remove-item -recurse -force ./build']],
  ])('%s %j → destructive', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('destructive');
  });

  it('reads a POSIX delete out of a bash -c payload', () => {
    const r = detectDanger('bash', ['-c', 'rm -rf /']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
  });

  it.each([
    ['bash', ['-c', 'git push --force origin main'], 'git-push-force'],
    ['sh', ['-c', 'git clean -xdf'], 'git-clean-force'],
    ['bash', ['-c', 'npm publish'], 'npm-publish'],
    ['bash', ['-c', 'kubectl delete namespace prod'], 'kubectl-delete-namespace'],
  ])('%s %j exposes rule %s', (cmd, args, rule) => {
    const r = detectDanger(cmd, args);
    expect(r.level).toBe('destructive');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.matchedRule === rule || r.reasons.length > 1).toBe(true);
  });

  // The payload's HEAD is the command, so a dangerous-looking string that is
  // merely an argument to something harmless must not be promoted.
  it.each([
    ['bash', ['-c', 'echo rm -rf /']],
    ['bash', ['-c', 'grep -r "rm -rf" src/']],
    ['bash', ['-c', 'echo "git push --force"']],
  ])('%s %j stays at caution (payload head is harmless)', (cmd, args) => {
    // `caution`, not `safe`, because the interpreter's own `inline-eval` rule
    // still fires — the payload just adds nothing above it.
    expect(detectDanger(cmd, args).level).toBe('caution');
  });

  // `inline-eval` deliberately lists only POSIX shells and script interpreters,
  // not `powershell`/`pwsh`, so a harmless PowerShell payload has no rule to
  // fire at all. Pinned so the difference is a known asymmetry rather than a
  // surprise: reading the payload must not invent danger where its head is inert.
  it('leaves a harmless PowerShell payload at safe', () => {
    expect(
      detectDanger('powershell', ['-Command', 'Write-Output "Remove-Item -Recurse -Force"']).level,
    ).toBe('safe');
  });

  // A bare single-token payload is already visible to every rule, and the
  // interpreter's own `inline-eval` caution still applies.
  it('keeps the interpreter rule firing alongside the payload rule', () => {
    const r = detectDanger('bash', ['-c', 'rm -rf /']);
    expect(r.reasons).toContain('inline script evaluation (-c / -e / --eval)');
  });

  it('does not treat a non-interpreter -c flag as a payload', () => {
    expect(detectDanger('gcc', ['-c', 'rm -rf /']).level).toBe('safe');
  });

  // POSIX shells take short options as a CLUSTER: `bash -lc "<cmd>"` (login
  // shell, the usual spelling in container and CI wrappers), `sh -ec`, `zsh -xc`.
  // Both the payload reader and the `inline-eval` rule matched the exact token
  // `-c`, so a clustered flag left its command string unread and the banner said
  // `safe` for the very command `bash -c` reports as destructive (the shape-
  // variance rule: a clustered spelling must classify like the pure one).
  describe('a clustered -c on a POSIX shell is the same inline payload', () => {
    it.each([
      ['bash', ['-lc', 'rm -rf ~/data'], 'destructive'],
      ['sh', ['-ec', 'rm -rf ~/data'], 'destructive'],
      ['zsh', ['-xc', 'rm -rf ~/data'], 'destructive'],
      ['bash', ['-lic', 'rm -rf ~/data'], 'destructive'],
      ['/bin/bash', ['-lc', 'rm -rf ~/data'], 'destructive'],
      ['bash', ['-lc', 'git push --force origin main'], 'destructive'],
      ['sh', ['-ec', 'git clean -xdf'], 'destructive'],
      ['bash', ['-lc', 'npm publish'], 'destructive'],
      ['bash', ['-lc', 'echo rm -rf /'], 'caution'],
      ['bash', ['-lc', 'echo hello world'], 'caution'],
    ])('%s %j → %s', (cmd, args, level) => {
      expect(detectDanger(cmd, args).level).toBe(level);
    });

    it('keeps the interpreter inline-eval reason beside the payload reason', () => {
      const r = detectDanger('bash', ['-lc', 'rm -rf ~/data']);
      expect(r.reasons).toContain('recursive force-delete');
      expect(r.reasons).toContain('inline script evaluation (-c / -e / --eval)');
    });

    // Not every cluster or program: no `c` in the cluster, a long option, a
    // script operand, a non-shell host, or an interpreter that takes no clusters.
    it.each([
      ['bash', ['-l', 'script.sh']],
      ['bash', ['-x', 'deploy.sh']],
      ['bash', ['--norc', 'script.sh']],
      ['gcc', ['-lc', 'rm -rf /']],
      ['grep', ['-lc', 'rm -rf x']],
      ['powershell', ['-lc', 'Remove-Item -Recurse -Force ./build']],
      ['node', ['-lc', 'rm -rf /']],
    ])('%s %j → safe (not a command-string flag)', (cmd, args) => {
      expect(detectDanger(cmd, args).level).toBe('safe');
    });

    it('still reads the unclustered spellings the same way', () => {
      expect(detectDanger('bash', ['-c', 'rm -rf ~/data']).level).toBe('destructive');
      expect(detectDanger('bash', ['-l', '-c', 'rm -rf ~/data']).level).toBe('destructive');
    });
  });
});

// A flag that is NOT a payload flag for this host, sitting in front of the real
// one, used to END the scan: `-e` is node/perl/ruby/python's eval flag, but for
// a POSIX shell it is errexit and takes no value at all, so
// `bash -e -c "rm -rf build"` read `-c` as `-e`'s operand, found no command line
// in it, and returned no pairs. No cmd-keyed rule saw `rm`, and the banner said
// `caution` for the very command `bash -c` reports as `destructive` — the same
// shape-variance class as the clustered `-lc` spelling above: the flag's
// POSITION must not decide the classification.
describe('a non-payload flag before the real payload flag does not end the scan', () => {
  it.each([
    ['bash', ['-e', '-c', 'rm -rf ./build'], 'destructive'],
    ['sh', ['-e', '-c', 'rm -rf ./build'], 'destructive'],
    ['zsh', ['-E', '-c', 'rm -rf ./build'], 'destructive'],
    ['bash', ['-e', '-c', 'git reset --hard'], 'destructive'],
    ['bash', ['-e', '-c', 'npm publish'], 'destructive'],
    // The re-read must stay honest: a harmless payload behind the same flags is
    // still only the interpreter's own `inline-eval` caution.
    ['bash', ['-e', '-c', 'ls -la'], 'caution'],
    ['node', ['-e', '1+1'], 'caution'],
  ])('%s %j → %s', (cmd, args, level) => {
    expect(detectDanger(cmd, args).level).toBe(level);
  });

  it('exposes the payload rule, not just the interpreter caution', () => {
    const r = detectDanger('bash', ['-e', '-c', 'rm -rf ./build']);
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.reasons).toContain('inline script evaluation (-c / -e / --eval)');
  });
});

describe('detectDanger — rm / rmdir recursive force', () => {
  it('flags `rm -rf ./build` as destructive', () => {
    const r = detectDanger('rm', ['-rf', './build']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags `rm -fr ./build` (alternative flag order) as destructive', () => {
    const r = detectDanger('rm', ['-fr', './build']);
    expect(r.level).toBe('destructive');
  });

  it('flags `rm -r -f ./build` (split flags) as destructive', () => {
    const r = detectDanger('rm', ['-r', '-f', './build']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `rm ./build` (no recursive)', () => {
    const r = detectDanger('rm', ['./build']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `rm -r ./build` (no force)', () => {
    const r = detectDanger('rm', ['-r', './build']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `ls -rf /` (not the rm binary)', () => {
    const r = detectDanger('ls', ['-rf', '/']);
    expect(r.level).toBe('safe');
  });

  it('flags `rm --recursive --force ./build` (GNU long forms) as destructive', () => {
    const r = detectDanger('rm', ['--recursive', '--force', './build']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags mixed short/long recursive force-delete as destructive', () => {
    expect(detectDanger('rm', ['-r', '--force', './build']).level).toBe('destructive');
    expect(detectDanger('rm', ['--recursive', '-f', './build']).level).toBe('destructive');
  });

  it('flags GNU -R spellings as destructive (uppercase R ≡ --recursive)', () => {
    expect(detectDanger('rm', ['-Rf', './build']).level).toBe('destructive');
    expect(detectDanger('rm', ['-fR', './build']).level).toBe('destructive');
    expect(detectDanger('rm', ['-R', '-f', './build']).level).toBe('destructive');
    expect(detectDanger('rm', ['-R', '--force', './build']).level).toBe('destructive');
  });

  it('keeps half-flag -R / -f shapes safe (lowercasing must not over-flag)', () => {
    expect(detectDanger('rm', ['-R', './build']).level).toBe('safe');
    expect(detectDanger('rm', ['-f', './build']).level).toBe('safe');
    expect(detectDanger('ls', ['-RF', 'dir']).level).toBe('safe');
  });

  it('does NOT flag `rm --recursive ./build` (long form, no force)', () => {
    expect(detectDanger('rm', ['--recursive', './build']).level).toBe('safe');
  });

  it('does NOT flag `rm --force ./build` (long form, no recursive)', () => {
    expect(detectDanger('rm', ['--force', './build']).level).toBe('safe');
  });

  it('flags `rmdir /s /q` (cmd.exe recursive force-delete) as destructive', () => {
    const r = detectDanger('rmdir', ['/s', '/q', 'node_modules']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags `rd /s /q` (rmdir alias) as destructive', () => {
    const r = detectDanger('rd', ['/s', '/q', 'node_modules']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags Windows slash-flags case-insensitively and in any order', () => {
    expect(detectDanger('rmdir', ['/S', '/Q', 'build']).level).toBe('destructive');
    expect(detectDanger('rd', ['/q', '/s', 'dist']).level).toBe('destructive');
  });

  it('keeps Windows half-flags safe (/s alone still prompts in cmd)', () => {
    expect(detectDanger('rmdir', ['/s', 'dir']).level).toBe('safe');
    expect(detectDanger('rd', ['/q', 'dir']).level).toBe('safe');
  });

  it('keeps POSIX rmdir (empty-dir removal, no recursive shape) safe', () => {
    expect(detectDanger('rmdir', ['somedir']).level).toBe('safe');
  });

  it('flags `del /f /s /q` (cmd.exe recursive file deletion) as destructive', () => {
    const r = detectDanger('del', ['/f', '/s', '/q', 'logs']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('recursive force-delete');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags `del /s` alone as destructive (del /s deletes the subtree without prompting)', () => {
    expect(detectDanger('del', ['/s', 'node_modules/.cache/*.log']).level).toBe('destructive');
    expect(detectDanger('del', ['/s', '/q', '*.tmp']).level).toBe('destructive');
  });

  it('flags `erase /s` as destructive (erase is a cmd alias of del)', () => {
    const r = detectDanger('erase', ['/s', '/q', 'dist']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('rm-recursive');
  });

  it('flags del/erase slash-flags case-insensitively and in any order', () => {
    expect(detectDanger('del', ['/Q', '/S', '/F', 'build']).level).toBe('destructive');
    expect(detectDanger('erase', ['/S', 'tmp']).level).toBe('destructive');
  });

  it('keeps non-recursive del/erase safe (single files, /f alone, quiet single-dir wildcard)', () => {
    expect(detectDanger('del', ['a.txt']).level).toBe('safe');
    expect(detectDanger('del', ['/f', 'a.txt']).level).toBe('safe');
    expect(detectDanger('del', ['/q', '*.log']).level).toBe('safe');
    expect(detectDanger('erase', ['b.txt']).level).toBe('safe');
  });
});

describe('detectDanger — PowerShell Remove-Item -Recurse -Force', () => {
  it('flags `powershell Remove-Item -Recurse -Force foo` as destructive', () => {
    const r = detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force', 'foo']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('powershell-remove-item-recursive-force');
  });

  it('flags `pwsh -Command "Remove-Item -R -F foo"` as destructive', () => {
    const r = detectDanger('pwsh', ['-Command', 'Remove-Item', '-R', '-F', 'foo']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `powershell Remove-Item -WhatIf -Recurse -Force foo` (dry-run)', () => {
    const r = detectDanger('powershell', ['Remove-Item', '-WhatIf', '-Recurse', '-Force', 'foo']);
    expect(r.level).toBe('safe');
  });

  it('flags lowercase parameters as destructive (PowerShell params are case-insensitive)', () => {
    expect(detectDanger('powershell', ['Remove-Item', '-recurse', '-force', './build']).level).toBe(
      'destructive',
    );
    expect(detectDanger('pwsh', ['Remove-Item', '-r', '-f', 'build']).level).toBe('destructive');
  });

  it('flags mixed-casing parameters as destructive', () => {
    expect(detectDanger('powershell', ['Remove-Item', '-Recurse', '-force', 'build']).level).toBe(
      'destructive',
    );
    expect(detectDanger('pwsh', ['Remove-Item', '-recurse', '-F', 'build']).level).toBe(
      'destructive',
    );
  });

  it('does NOT flag lowercase `-whatif` (dry-run, any casing)', () => {
    const r = detectDanger('powershell', ['Remove-Item', '-whatif', '-recurse', '-force', 'foo']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `powershell Get-ChildItem -Recurse` (different verb)', () => {
    const r = detectDanger('powershell', ['Get-ChildItem', '-Recurse']);
    expect(r.level).toBe('safe');
  });

  it('flags explicit `:$true` switch-value spellings as destructive', () => {
    // PowerShell switch parameters accept an explicit boolean value form:
    // `-Recurse:$true` ≡ `-Recurse`, `-Force:$true` ≡ `-Force`. Both are a
    // verbatim recursive force-delete and must hit the confirm gate.
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse:$true', '-Force', 'foo']).level,
    ).toBe('destructive');
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force:$true', 'foo']).level,
    ).toBe('destructive');
    expect(
      detectDanger('pwsh', ['Remove-Item', '-Recurse:$true', '-Force:$true', 'foo']).level,
    ).toBe('destructive');
  });

  it('does NOT flag `:$false` switch-value spellings (switch explicitly OFF)', () => {
    // `-Recurse:$false` turns recursion OFF and `-Force:$false` turns force
    // OFF — neither is a recursive force-delete, so both stay safe.
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse:$false', '-Force', 'foo']).level,
    ).toBe('safe');
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force:$false', 'foo']).level,
    ).toBe('safe');
  });

  it('exempts explicit `-WhatIf:$true` (dry-run) and NOT `-WhatIf:$false` (executes)', () => {
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force', '-WhatIf:$true', 'foo'])
        .level,
    ).toBe('safe');
    expect(
      detectDanger('powershell', ['Remove-Item', '-Recurse', '-Force', '-WhatIf:$false', 'foo'])
        .level,
    ).toBe('destructive');
  });
});

describe('detectDanger — find -exec / -ok', () => {
  it('flags `find . -exec rm {} ;` as destructive', () => {
    const r = detectDanger('find', ['.', '-exec', 'rm', '{}', ';']);
    expect(r.level).toBe('destructive');
  });

  it('flags `find . -ok echo` as destructive', () => {
    const r = detectDanger('find', ['.', '-ok', 'echo']);
    expect(r.level).toBe('destructive');
  });

  it('flags `find . -execdir rm` as destructive', () => {
    const r = detectDanger('find', ['.', '-execdir', 'rm']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `find . -name "*.tmp"` (no -exec)', () => {
    const r = detectDanger('find', ['.', '-name', '*.tmp']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git --exec/--upload-pack/--receive-pack', () => {
  it('flags `git --exec=foo fetch` as destructive', () => {
    const r = detectDanger('git', ['--exec=foo', 'fetch']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git --upload-pack=evil` as destructive', () => {
    const r = detectDanger('git', ['--upload-pack=evil']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git status`', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — Windows format / diskpart / bcdedit', () => {
  it('flags `format C:` as destructive', () => {
    const r = detectDanger('format', ['C:']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('win32-format');
  });

  it('flags `format.exe C: /q` as destructive', () => {
    const r = detectDanger('format.exe', ['C:', '/q']);
    expect(r.level).toBe('destructive');
  });

  it('flags `diskpart` with no args as destructive', () => {
    const r = detectDanger('diskpart', []);
    expect(r.level).toBe('destructive');
  });

  it('flags `bcdedit /set` as destructive', () => {
    const r = detectDanger('bcdedit', [
      '/set',
      '{default}',
      'bootstatuspolicy',
      'ignoreallfailures',
    ]);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — mkfs family', () => {
  it('flags `mkfs.ext4 /dev/sda1` as destructive', () => {
    const r = detectDanger('mkfs.ext4', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkfs` (no extension) as destructive', () => {
    const r = detectDanger('mkfs', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkswap /dev/sda2` as destructive', () => {
    const r = detectDanger('mkswap', ['/dev/sda2']);
    expect(r.level).toBe('destructive');
  });

  it('flags `mkfs.typo` (unknown extension still matches the general pattern)', () => {
    // The regex /^mkfs(\.[a-z0-9]+)?$/ matches mkfs followed by optional ext,
    // so even an unknown extension triggers. This is intentional: a typo'd
    // filesystem type is a dangerous mistake.
    const r = detectDanger('mkfs.typo', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — dd writing to a block device', () => {
  it('flags `dd if=foo of=/dev/sda` as destructive', () => {
    const r = detectDanger('dd', ['if=foo.img', 'of=/dev/sda']);
    expect(r.level).toBe('destructive');
  });

  it('flags `dd of=/dev/nvme0n1` as destructive', () => {
    const r = detectDanger('dd', ['of=/dev/nvme0n1']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `dd if=/dev/urandom of=output.bin` (writing to a file)', () => {
    const r = detectDanger('dd', ['if=/dev/urandom', 'of=output.bin', 'bs=1M', 'count=10']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — secure-erase tools', () => {
  it('flags `shred secret.txt` as destructive', () => {
    const r = detectDanger('shred', ['secret.txt']);
    expect(r.level).toBe('destructive');
  });

  it('flags `wipefs /dev/sda1` as destructive', () => {
    const r = detectDanger('wipefs', ['/dev/sda1']);
    expect(r.level).toBe('destructive');
  });

  it('flags `sdelete -p 3 secret.txt` as destructive', () => {
    const r = detectDanger('sdelete', ['-p', '3', 'secret.txt']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — safe baseline (regression)', () => {
  it('returns level=safe for `git status`', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
    expect(r.reasons).toEqual([]);
    expect(r.matchedRule).toBeUndefined();
  });

  it('returns level=safe for `npm test`', () => {
    const r = detectDanger('npm', ['test']);
    expect(r.level).toBe('safe');
  });

  it('returns level=caution for `python -c "print(1)"` (inline-eval)', () => {
    const r = detectDanger('python', ['-c', 'print(1)']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('inline-eval');
  });

  it('returns level=safe for `cargo build`', () => {
    const r = detectDanger('cargo', ['build']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — git push --force / -f', () => {
  it('flags `git push --force origin main` as destructive', () => {
    const r = detectDanger('git', ['push', '--force', 'origin', 'main']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-push-force');
  });

  it('flags `git push -f` (short form) as destructive', () => {
    const r = detectDanger('git', ['push', '-f']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git push --force-with-lease` as destructive (still rewrites)', () => {
    const r = detectDanger('git', ['push', '--force-with-lease', 'origin', 'main']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git push origin main` (no force flag)', () => {
    const r = detectDanger('git', ['push', 'origin', 'main']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git status --force` (--force belongs to a different verb)', () => {
    // The rule looks for the `push` subcommand first; `status` is unrelated.
    const r = detectDanger('git', ['status', '--force']);
    expect(r.level).toBe('safe');
  });

  it('flags `git push origin +main` (per-refspec force) as destructive', () => {
    const r = detectDanger('git', ['push', 'origin', '+main']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-push-force');
  });

  it('flags `git push +main` (bare refspec force) as destructive', () => {
    expect(detectDanger('git', ['push', '+main']).level).toBe('destructive');
  });

  it('flags `git push origin +HEAD:refs/heads/main` (CI force-push form) as destructive', () => {
    expect(detectDanger('git', ['push', 'origin', '+HEAD:refs/heads/main']).level).toBe(
      'destructive',
    );
  });

  it('flags wildcard `+refs/heads/*:refs/heads/*` refspec force as destructive', () => {
    expect(detectDanger('git', ['push', 'origin', '+refs/heads/*:refs/heads/*']).level).toBe(
      'destructive',
    );
  });

  it('keeps non-force plus/exclusion refspecs safe (`feature+fix`, `^main`)', () => {
    expect(detectDanger('git', ['push', 'origin', 'feature+fix']).level).toBe('safe');
    expect(detectDanger('git', ['push', 'origin', '^main']).level).toBe('safe');
  });

  it('exempts `--dry-run` force pushes (rewrites nothing)', () => {
    expect(detectDanger('git', ['push', '--dry-run', 'origin', '+main']).level).toBe('safe');
    expect(detectDanger('git', ['push', '-n', 'origin', '+main']).level).toBe('safe');
    expect(detectDanger('git', ['push', '-nf', 'origin', '+main']).level).toBe('safe');
  });

  it('flags combined short-flag clusters containing -f as destructive', () => {
    // Git combines short flags, so `-fv` ≡ `-f -v`, `-vf` ≡ `-v -f`,
    // `-vfu` ≡ `-v -f -u`. Each is a verbatim force-push that rewrites remote
    // history and must hit the destructive confirm gate like the canonical
    // `-f` spelling. Previously only the exact `-f` token fired the rule, so a
    // cluster of git push's other short flags (-q -v -u -o) silently hid it.
    expect(detectDanger('git', ['push', '-fv', 'origin', 'main']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '-vf', 'origin', 'main']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '-vfu', 'origin', 'main']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '-fvq', 'origin', 'main']).level).toBe('destructive');
  });

  it('still treats non-force short clusters as safe', () => {
    // `-v` (verbose) and `-u` (set-upstream) alone do not rewrite history.
    expect(detectDanger('git', ['push', '-v', 'origin', 'main']).level).toBe('safe');
    expect(detectDanger('git', ['push', '-vu', 'origin', 'main']).level).toBe('safe');
  });
});

describe('detectDanger — git reset --hard', () => {
  it('flags `git reset --hard HEAD~1` as destructive', () => {
    const r = detectDanger('git', ['reset', '--hard', 'HEAD~1']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-reset-hard');
  });

  it('flags `git reset --hard=foo` (rare `--key=value` form) as destructive', () => {
    const r = detectDanger('git', ['reset', '--hard=foo']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git reset --soft HEAD~1` (soft, recoverable)', () => {
    const r = detectDanger('git', ['reset', '--soft', 'HEAD~1']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git reset HEAD~1` (mixed reset, no --hard)', () => {
    const r = detectDanger('git', ['reset', 'HEAD~1']);
    expect(r.level).toBe('safe');
  });
});

// `git filter-branch` / `git filter-repo` rewrite every commit in place — the
// one pair of commands that can destroy a repository's whole history. The YOLO
// gate's `git-history` kind lists them beside `reset --hard`, `clean -f` and
// `push --force` (core yolo-vcs-risk), and this module already classified the
// other three, so the exec banner said `safe` for the most damaging one.
describe('detectDanger — git filter-branch / filter-repo', () => {
  it.each([
    ['git', ['filter-branch', '--tree-filter', 'rm -f secrets.txt', 'HEAD']],
    ['git', ['filter-branch', '--all']],
    ['git', ['filter-repo', '--path', 'src']],
    ['git', ['filter-repo', '--invert-paths', '--path', 'big.bin']],
    // Global options precede the subcommand and must not hide it.
    ['git', ['-C', '/work/repo', 'filter-branch', '--all']],
    ['git', ['-c', 'core.x=1', 'filter-repo', '--force']],
    ['git', ['--no-pager', 'filter-branch', 'HEAD']],
    ['git', ['--git-dir', '/x/.git', 'filter-branch', 'HEAD']],
  ])('%s %j → destructive (git-history-rewrite)', (cmd, args) => {
    const r = detectDanger(cmd, args);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-history-rewrite');
    expect(r.reasons).toContain(
      'git filter-branch / filter-repo (rewrites every commit in the history)',
    );
  });

  // The word is only dangerous as the SUBCOMMAND: a branch, path, commit
  // message or search term named after it stays safe, as do unrelated commands.
  it.each([
    ['git', ['commit', '-m', 'filter-branch notes']],
    ['git', ['log', '--grep', 'filter-branch']],
    ['git', ['branch', '-d', 'filter-branch']],
    ['git', ['checkout', 'filter-repo']],
    ['git', ['status']],
    ['git', ['rebase', '-i', 'HEAD~3']],
    ['echo', ['filter-branch']],
    ['svn', ['filter-branch']],
  ])('%s %j → safe (not the subcommand)', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('safe');
  });

  it('can be bypassed per rule id like every other rule', () => {
    expect(
      detectDanger('git', ['filter-branch', '--all'], new Set(['git-history-rewrite'])).level,
    ).toBe('safe');
  });

  it('still reads the sibling history rules unchanged', () => {
    expect(detectDanger('git', ['reset', '--hard']).level).toBe('destructive');
    expect(detectDanger('git', ['clean', '-fd']).level).toBe('destructive');
    expect(detectDanger('git', ['push', '--force']).level).toBe('destructive');
  });
});

describe('detectDanger — git clean -f', () => {
  it('flags `git clean -fd` as destructive', () => {
    const r = detectDanger('git', ['clean', '-fd']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-clean-force');
  });

  it('flags combined short-flag clusters regardless of letter order', () => {
    // git parses `-df` exactly like `-d -f`; the force flag must be detected by
    // cluster membership, not by `f` happening to be the first letter.
    for (const args of [
      ['clean', '-df'],
      ['clean', '-xdf'],
      ['clean', '-Xf'],
    ]) {
      const r = detectDanger('git', args);
      expect(r.level, args.join(' ')).toBe('destructive');
      expect(r.matchedRule, args.join(' ')).toBe('git-clean-force');
    }
  });

  it('does NOT flag a dry-run cluster containing n', () => {
    for (const args of [
      ['clean', '-n'],
      ['clean', '-nd'],
      ['clean', '-ndf'],
      ['clean', '--dry-run'],
    ]) {
      expect(detectDanger('git', args).level, args.join(' ')).toBe('safe');
    }
  });

  it('flags `git clean -f` (no -d) as destructive', () => {
    const r = detectDanger('git', ['clean', '-f']);
    expect(r.level).toBe('destructive');
  });

  it('flags `git clean --force` as destructive', () => {
    const r = detectDanger('git', ['clean', '--force']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `git clean -n` (dry-run, no force)', () => {
    const r = detectDanger('git', ['clean', '-n']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `git status` (different verb)', () => {
    const r = detectDanger('git', ['status']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — package publish', () => {
  it('flags `npm publish` as destructive', () => {
    const r = detectDanger('npm', ['publish']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('npm-publish');
  });

  it('flags `pnpm publish --tag beta` as destructive', () => {
    const r = detectDanger('pnpm', ['publish', '--tag', 'beta']);
    expect(r.level).toBe('destructive');
  });

  it('flags `cargo publish --allow-dirty` as destructive', () => {
    const r = detectDanger('cargo', ['publish', '--allow-dirty']);
    expect(r.level).toBe('destructive');
  });

  it('flags `cargo yank --version 1.0.0` as destructive (treats as publish-class)', () => {
    const r = detectDanger('cargo', ['yank', '--version', '1.0.0']);
    expect(r.level).toBe('destructive');
  });

  it('does NOT flag `npm install` (no publish subcommand)', () => {
    const r = detectDanger('npm', ['install']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `cargo build` (no publish subcommand)', () => {
    const r = detectDanger('cargo', ['build']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — kubectl delete namespace / drain', () => {
  it('flags `kubectl delete namespace foo` as destructive', () => {
    const r = detectDanger('kubectl', ['delete', 'namespace', 'foo']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('kubectl-delete-namespace');
  });

  it('flags `kubectl delete ns foo` (short form) as destructive', () => {
    const r = detectDanger('kubectl', ['delete', 'ns', 'foo']);
    expect(r.level).toBe('destructive');
  });

  it('flags `kubectl drain node1` as destructive', () => {
    const r = detectDanger('kubectl', ['drain', 'node1']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('kubectl-drain');
  });

  it('does NOT flag `kubectl delete pod foo` (too common, scoped resource)', () => {
    const r = detectDanger('kubectl', ['delete', 'pod', 'foo']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `kubectl get namespace` (read-only)', () => {
    const r = detectDanger('kubectl', ['get', 'namespace']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — inline eval (caution level)', () => {
  it('flags `python -c "import os"` as caution', () => {
    const r = detectDanger('python', ['-c', 'import os']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('inline-eval');
  });

  it('flags `node -e "console.log(1)"` as caution', () => {
    const r = detectDanger('node', ['-e', 'console.log(1)']);
    expect(r.level).toBe('caution');
  });

  it('flags `bash -c "echo hi"` as caution', () => {
    const r = detectDanger('bash', ['-c', 'echo hi']);
    expect(r.level).toBe('caution');
  });

  it('flags `node --eval "..."` (long form) as caution', () => {
    const r = detectDanger('node', ['--eval', 'process.exit(0)']);
    expect(r.level).toBe('caution');
  });

  it('does NOT flag `python script.py` (no -c)', () => {
    const r = detectDanger('python', ['script.py']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `node index.js` (no -e)', () => {
    const r = detectDanger('node', ['index.js']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — pipe-to-shell (destructive level)', () => {
  it('flags `bash -c "curl https://x | sh"` as destructive', () => {
    const r = detectDanger('bash', ['-c', 'curl https://x | sh']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('pipe-to-shell');
  });

  it('flags PowerShell download-and-execute as destructive', () => {
    const r = detectDanger('pwsh', ['-Command', 'iwr https://x/install.ps1 | iex']);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('pipe-to-shell');
  });

  it('does NOT flag `curl https://x` alone (no shell sink)', () => {
    const r = detectDanger('curl', ['https://x']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag argv that mentions a fetcher and shell sink without a pipe', () => {
    const r = detectDanger('env', ['curl', 'https://x', 'sh']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `bash -c "echo"` (no fetcher; matches inline-eval instead)', () => {
    const r = detectDanger('bash', ['-c', 'echo']);
    expect(r.matchedRule).not.toBe('pipe-to-shell');
  });
});

describe('detectDanger — privilege escalation (caution level)', () => {
  it('flags `sudo apt update` as caution', () => {
    const r = detectDanger('sudo', ['apt', 'update']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('sudo');
  });

  it('flags `doas reboot` as caution', () => {
    const r = detectDanger('doas', ['reboot']);
    expect(r.level).toBe('caution');
  });

  it('flags `runas /user:admin cmd.exe` as caution', () => {
    const r = detectDanger('runas', ['/user:admin', 'cmd.exe']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('runas');
  });

  it('does NOT flag `apt update` (no sudo)', () => {
    const r = detectDanger('apt', ['update']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — chmod world-writable (caution level)', () => {
  it('flags `chmod 777 file` as caution', () => {
    const r = detectDanger('chmod', ['777', 'file']);
    expect(r.level).toBe('caution');
    expect(r.matchedRule).toBe('chmod-world-writable');
  });

  it('flags `chmod 0644 file` as safe (no 7)', () => {
    const r = detectDanger('chmod', ['0644', 'file']);
    expect(r.level).toBe('safe');
  });

  it('flags `chmod 755 dir` as caution (group is 5 but other is 7)', () => {
    const r = detectDanger('chmod', ['755', 'dir']);
    expect(r.level).toBe('caution');
  });

  it('does NOT flag `chmod +x file` (symbolic mode)', () => {
    const r = detectDanger('chmod', ['+x', 'file']);
    expect(r.level).toBe('safe');
  });

  it('does NOT flag `chmod u+w file` (symbolic, scoped)', () => {
    const r = detectDanger('chmod', ['u+w', 'file']);
    expect(r.level).toBe('safe');
  });
});

describe('detectDanger — multi-rule interaction', () => {
  it('returns the higher level when multiple rules fire', () => {
    // `bash -c "curl ... | sh"` triggers both `inline-eval` (caution) and
    // `pipe-to-shell` (destructive). The output should be destructive.
    const r = detectDanger('bash', ['-c', 'curl https://x | sh']);
    expect(r.level).toBe('destructive');
    expect(r.reasons).toContain('inline script evaluation (-c / -e / --eval)');
    expect(r.reasons).toContain('network fetch piped to a shell (download-and-run pattern)');
  });

  it('does not downgrade a destructive result', () => {
    const r = detectDanger('git', ['push', '--force', 'origin', 'main']);
    expect(r.level).toBe('destructive');
  });
});

describe('detectDanger — bypass argument', () => {
  it('skips a rule whose id is in the bypass set', () => {
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('rm', ['-rf', './build'], bypass);
    expect(r.level).toBe('safe');
    expect(r.reasons).toEqual([]);
    expect(r.matchedRule).toBeUndefined();
  });

  it('ignores unknown bypass ids (forward-compat: future rule can be referenced)', () => {
    const bypass = new Set(['this-rule-does-not-exist']);
    const r = detectDanger('rm', ['-rf', './build'], bypass);
    // Unknown bypass id should not affect anything; rm-recursive still fires.
    expect(r.level).toBe('destructive');
  });

  it('skips only the specified rule; other matched rules still fire', () => {
    // Bypass `rm-recursive` but keep `sudo` active. `sudo rm -rf /` then
    // has the destructive rule suppressed, leaving only the caution rule.
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('sudo', ['rm', '-rf', '/'], bypass);
    expect(r.level).toBe('caution');
    expect(r.reasons).toEqual(['privilege escalation (sudo / doas)']);
  });

  it('treats empty bypass the same as no bypass (default behavior)', () => {
    const emptyBypass = new Set<string>();
    const noBypass = undefined;
    const a = detectDanger('rm', ['-rf', './build'], emptyBypass);
    const b = detectDanger('rm', ['-rf', './build'], noBypass);
    expect(a).toEqual(b);
    expect(a.level).toBe('destructive');
  });

  it('bypasses a caution-level rule (e.g. inline-eval)', () => {
    const bypass = new Set(['inline-eval']);
    const r = detectDanger('python', ['-c', 'import os'], bypass);
    expect(r.level).toBe('safe');
  });

  it('does NOT silently suppress unmatched rules when bypass is provided', () => {
    // Bypass `rm-recursive`, but invoke a different destructive rule. The
    // bypass should not affect it.
    const bypass = new Set(['rm-recursive']);
    const r = detectDanger('git', ['push', '--force', 'origin', 'main'], bypass);
    expect(r.level).toBe('destructive');
    expect(r.matchedRule).toBe('git-push-force');
  });

  it('handles bypass with multiple ids', () => {
    const bypass = new Set(['rm-recursive', 'git-push-force', 'inline-eval']);
    const r1 = detectDanger('rm', ['-rf', 'foo'], bypass);
    const r2 = detectDanger('git', ['push', '--force'], bypass);
    const r3 = detectDanger('python', ['-c', 'evil'], bypass);
    expect(r1.level).toBe('safe');
    expect(r2.level).toBe('safe');
    expect(r3.level).toBe('safe');
  });
});

/**
 * PARITY GUARD — the `ARGV_LAUNCHERS.valueFlags` above and core's
 * `HALT_LAUNCHER_VALUE_FLAGS` (packages/core/src/security/yolo-risk.ts) are two
 * hand-copied mirrors of one fact: which flags take a SEPARATED value, per
 * launcher. Nothing imports the other. This is the drift the code comments have
 * claimed was mirrored since 2026-09-19 while no mechanism enforced it — and the
 * drift that actually shipped, when core flattened every launcher's letters into
 * one global class and so credited `exec` with `timeout`'s `-s` (making
 * `exec -S grep shutdown` a machine halt) while dropping `exec`'s own `-a`
 * (making `exec -a name shutdown -h now` invisible). Both directions of the same
 * root cause: a wrong swallow hides the real command or promotes a word that is
 * not one.
 *
 * The tables are compared as DATA, not by scraping each file's source. A regex
 * over source matches nothing after any refactor and then passes vacuously —
 * exactly how the original "mirrors ARGV_LAUNCHERS" comment drifted from the
 * mirror it described. Both symbols are recorded as test-only exports in
 * architecture/test-only-exports.json.
 */
describe('core and tools launcher value-flag tables stay in parity', () => {
  const shared = [...ARGV_LAUNCHERS.keys()].filter((name) => HALT_LAUNCHER_VALUE_FLAGS.has(name));

  it('compares a non-empty overlap (a vacuous pass is still a pass)', () => {
    expect(ARGV_LAUNCHERS.size).toBeGreaterThan(8);
    expect(HALT_LAUNCHER_VALUE_FLAGS.size).toBeGreaterThan(8);
    // Every tools-side launcher must also exist on the core side: a launcher
    // added to one table but not the other is the drift that hides a command.
    expect(shared).toHaveLength(ARGV_LAUNCHERS.size);
  });

  it.each(shared)('%s — value flags match core exactly', (name) => {
    expect([...(HALT_LAUNCHER_VALUE_FLAGS.get(name) ?? [])].sort()).toEqual(
      [...(ARGV_LAUNCHERS.get(name)?.valueFlags ?? [])].sort(),
    );
  });

  it('core adds only the documented `time` launcher', () => {
    // GNU `time -o FILE` / `-f FORMAT` take values, but the tools table never
    // peels `time` at all, so this is a deliberate one-sided addition. Listing
    // it here forces any future addition to one table to be decided, not missed.
    expect([...HALT_LAUNCHER_VALUE_FLAGS.keys()].filter((n) => !ARGV_LAUNCHERS.has(n))).toEqual([
      'time',
    ]);
  });

  it('keeps `env` split-string flags out of both value-flag sets', () => {
    // `-S` carries a whole command line that env SPLITS AND RUNS, so it is not a
    // value to skip past: tools expands it through `splitStringFlags`, core
    // through COMMAND_STRING_FLAGS. Listing `-S` as value-taking would skip the
    // payload entirely and report `env` as the command being run.
    for (const [name, spec] of ARGV_LAUNCHERS) {
      for (const flag of spec.splitStringFlags ?? []) {
        expect(HALT_LAUNCHER_VALUE_FLAGS.get(name) ?? []).not.toContain(flag);
      }
    }
  });

  // SECOND CHANNEL: flags whose value is a whole command line the launcher
  // splits and runs. Tools models it as `ARGV_LAUNCHERS.splitStringFlags`; core
  // as `COMMAND_STRING_FLAGS`. Drift here is the loudest kind of silent: a
  // wrapped `env -S "git push --force"` stays visible to one classifier and
  // invisible to the other. NOTE the tables are deliberately NOT the same size:
  // core must also expand the shells (`sh -c`, `pwsh -command`, `cmd /c`) because
  // its bash-path classifier receives one string, while the tools argv path has
  // no launcher to peel there — `sh` is already the command, owned by the
  // inline-eval rule. So parity is asserted over the launchers they share, plus a
  // pinned list of what core alone may carry.
  //
  // core stores flags LOWERCASED (its matcher compares lowercased); tools keeps
  // the documented spelling (`-S`), so both sides are normalized before compare.
  const lower = (flags: Iterable<string>) => [...flags].map((flag) => flag.toLowerCase()).sort();

  const commandStringLaunchers = [...ARGV_LAUNCHERS].filter(
    ([, spec]) => spec.splitStringFlags !== undefined,
  );

  it('the split-string channel is compared over a non-empty set', () => {
    expect(commandStringLaunchers.length).toBeGreaterThan(0);
    expect(COMMAND_STRING_FLAGS.size).toBeGreaterThan(8);
  });

  it.each(commandStringLaunchers.map(([name]) => name))(
    '%s — tools splitStringFlags are all expanded by core',
    (name) => {
      const core = lower(COMMAND_STRING_FLAGS.get(name) ?? []);
      for (const flag of ARGV_LAUNCHERS.get(name)?.splitStringFlags ?? []) {
        expect(core).toContain(flag.toLowerCase());
      }
    },
  );

  it.each(commandStringLaunchers.map(([name]) => name))(
    '%s — core adds no command-string flag the tools table does not declare',
    (name) => {
      const tools = lower(ARGV_LAUNCHERS.get(name)?.splitStringFlags ?? []);
      expect(lower(COMMAND_STRING_FLAGS.get(name) ?? [])).toEqual(tools);
    },
  );

  it('core carries command-string flags only for env plus the documented shells', () => {
    // `cmd` (Windows cmd.exe) and tools' `command` (POSIX builtin) are different
    // programs with different spellings — not a drift to "fix" by renaming.
    expect(
      [...COMMAND_STRING_FLAGS.keys()].filter((name) => !ARGV_LAUNCHERS.has(name)).sort(),
    ).toEqual(['ash', 'bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh']);
  });
});
