import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, tokenizeCommand } from '../../src/slash-commands/dev.js';

/**
 * Regression tests for the /dev runCommand rewrite (BIZ-001 / BIZ-002).
 *
 * BIZ-001: the old execFile(cmd, [], { shell: false }) passed the WHOLE
 * command string as one argv element, so any command with arguments ENOENT'd
 * on POSIX — and the string error.code was mapped to exitCode 0, rendering
 * the failure as a green OK.
 *
 * BIZ-002: the old Windows metacharacter filter rejected `/` and `\`, so the
 * command's own documented example `ls -la src/` was refused. Path separators
 * are not cmd.exe operators; the canonical shim builder now validates the
 * real operators per token.
 *
 * These tests run cross-platform: on Windows the invocation goes through the
 * hardened cmd.exe shim, on POSIX through a shell-less spawn.
 */
describe('/dev runCommand (BIZ-001/BIZ-002 regression)', () => {
  const cwd = os.tmpdir();
  const isWin = process.platform === 'win32';

  it('tokenizes a command line into program + argv with quoting rules', () => {
    expect(tokenizeCommand('git diff --stat')).toEqual(['git', 'diff', '--stat']);
    expect(tokenizeCommand('  ls   -la   src/  ')).toEqual(['ls', '-la', 'src/']);
    // Double-quoted arg keeps internal whitespace as one token.
    expect(tokenizeCommand('node -e "process.stdout.write(1)"')).toEqual([
      'node',
      '-e',
      'process.stdout.write(1)',
    ]);
    // Single quotes are literal containers.
    expect(tokenizeCommand("echo 'a b c'")).toEqual(['echo', 'a b c']);
    // Backslash escapes the next character outside quotes — POSIX rule.
    // (Pinned to linux: on win32 `\` is a path separator and stays literal.)
    expect(tokenizeCommand('echo a\\ b', 'linux')).toEqual(['echo', 'a b']);
    // Empty string yields no tokens.
    expect(tokenizeCommand('   ')).toEqual([]);
    // Unterminated quote is an error, surfaced as a spawn failure by runCommand.
    expect(() => tokenizeCommand('echo "open')).toThrow(/Unterminated/);
  });

  it('keeps Windows backslash path separators literal on win32 (chimera follow-up to BIZ-002)', () => {
    // On win32, `\` is a path separator — treating it as a POSIX escape
    // corrupted `C:\Users\foo` into `C:Usersfoo`.
    expect(tokenizeCommand('C:\\Users\\foo\\tool.exe --out C:\\tmp\\o.json', 'win32')).toEqual([
      'C:\\Users\\foo\\tool.exe',
      '--out',
      'C:\\tmp\\o.json',
    ]);
    // Single quotes stay literal containers on both platforms.
    expect(tokenizeCommand("echo 'a b'", 'win32')).toEqual(['echo', 'a b']);
    // POSIX keeps shell escape semantics for the same input: each `\`
    // escapes the next character, so the path collapses.
    expect(tokenizeCommand('C:\\Users\\foo\\tool.exe', 'linux')).toEqual(['C:Usersfootool.exe']);
  });

  it('runs a multi-word command: program and args reach the process (BIZ-001)', async () => {
    // Under the old code this exact shape (program + two args) could never
    // start on POSIX — the whole string was argv[0].
    const marker = 'dev-multi-word-ok';
    const result = await runCommand(`node -e "process.stdout.write('${marker}')"`, cwd, 15_000);
    expect(result.spawnFailed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(marker);
  });

  it('accepts path separators in arguments (BIZ-002)', async () => {
    // `/` (and `\` on Windows) used to be rejected outright by the old
    // metacharacter filter. Neither is a cmd.exe operator; only real operators
    // are refused. path.join emits the platform separator, so both forms are
    // exercised without shell-escaping gymnastics in the assertion.
    const result = await runCommand(
      "node -e \"process.stdout.write(require('node:path').join('src','lib','utils.js'))\"",
      cwd,
      15_000,
    );
    expect(result.spawnFailed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/src[\\/]+lib[\\/]+utils\.js/);
  });

  it('reports a nonexistent binary as a failure — never exit 0 / OK (BIZ-001)', async () => {
    const result = await runCommand(
      'definitely-not-a-real-binary-wstack --flag value',
      cwd,
      15_000,
    );
    // The core regression: a spawn failure must not map to 0.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
    // On POSIX the spawn itself fails (127 + spawnFailed); on Windows cmd.exe
    // starts and reports not-found as a non-zero exit (9009) instead.
    if (!isWin) {
      expect(result.spawnFailed).toBe(true);
      expect(result.exitCode).toBe(127);
    }
  });

  it('propagates a real non-zero exit code exactly', async () => {
    const result = await runCommand('node -e "process.exit(42)"', cwd, 15_000);
    expect(result.spawnFailed).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('kills a runaway command at the timeout — never exit 0 / OK', async () => {
    // NOTE: the child body avoids `=>` — the arrow's `>` is a cmd.exe
    // operator the win32 shim refuses (correctly, 127), which would test
    // the refusal instead of the timeout.
    const result = await runCommand('node -e "setTimeout(function(){}, 30000)"', cwd, 500);
    // The invariant that matters (BIZ-001): a killed command must never
    // report success. Since the timedOut fix derives from child.killed (the
    // only kill this handle can issue is the spawn timeout), BOTH platforms
    // report the timeout convention: 124 + timedOut. (Previously Windows
    // TerminateProcess surfaced as a plain EXIT 1, and POSIX conflated any
    // foreign signal with TIMEOUT.)
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
  });

  it('distinguishes a foreign signal death from a timeout kill (chimera regression)', async () => {
    if (isWin) return; // Windows has no real signals; TerminateProcess → exit 1
    // The child kills ITSELF with SIGTERM. Our handle never calls kill(), so
    // child.killed stays false and this must NOT render as a TIMEOUT.
    // Old code mapped any signal to 124/TIMEOUT; shell convention is 128+15.
    const result = await runCommand(
      'node -e "process.kill(process.pid, \'SIGTERM\')"',
      cwd,
      15_000,
    );
    expect(result.exitCode).toBe(143);
    expect(result.killed).toBe(true);
    expect(result.signalName).toBe('SIGTERM');
    expect(result.timedOut).toBeUndefined();
  });

  it('decodes multi-byte UTF-8 output without replacement chars (chimera regression)', async () => {
    // The child generates the volume ITSELF: 50k '€' (3 bytes each) ≈ 150 KB
    // across many stdout chunks, so sequences almost certainly straddle chunk
    // boundaries — per-chunk toString('utf8') produced U+FFFD for every
    // straddled sequence. (Generating the text here would embed 150 KB in the
    // command line, which the Windows cmd.exe shim cannot carry.)
    const result = await runCommand(
      'node -e "process.stdout.write(\'€\'.repeat(50000))"',
      cwd,
      30_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stdout).toBe('€'.repeat(50_000));
  });

  it('keeps non-special backslashes literal inside double quotes on POSIX (chimera regression)', () => {
    // Inside double quotes, bash escapes ONLY the four characters it treats
    // specially there (double-quote, backslash, dollar, backtick) plus
    // newline-continuation. For anything else the backslash is LITERAL, so a
    // regex argument keeps it — the previous code ate it, corrupting the
    // two-char sequence for digits into a bare "d+".
    expect(tokenizeCommand('grep -E "\\d+-\\w+" file.txt', 'linux')).toEqual([
      'grep',
      '-E',
      '\\d+-\\w+',
      'file.txt',
    ]);
    // The four special characters ARE unescaped inside double quotes:
    expect(tokenizeCommand('echo "a\\"b"', 'linux')).toEqual(['echo', 'a"b']);
    expect(tokenizeCommand('echo "a\\\\b"', 'linux')).toEqual(['echo', 'a\\b']);
    expect(tokenizeCommand('echo "a\\$b"', 'linux')).toEqual(['echo', 'a$b']);
    expect(tokenizeCommand('echo "a\\`b"', 'linux')).toEqual(['echo', 'a`b']);
    // Windows: backslash inside double quotes stays a path separator.
    expect(tokenizeCommand('echo "a\\b"', 'win32')).toEqual(['echo', 'a\\b']);
  });

  it('surfaces tokenizer errors as a spawn failure instead of throwing', async () => {
    const result = await runCommand('echo "unterminated', cwd, 15_000);
    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('Unterminated');
  });

  it('rejects real cmd.exe operators inside a token on Windows', async () => {
    if (!isWin) return; // shell-less POSIX treats & as a literal argv char
    // The shim builder refuses tokens containing & — no cmd.exe injection.
    const result = await runCommand('echo a&calc', cwd, 15_000);
    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('metacharacter');
  });

  it('resolves cwd for the spawned process', async () => {
    // Print cwd from inside the child and compare against the option. Use
    // forward slashes for a platform-tolerant comparison.
    const result = await runCommand(
      'node -e "process.stdout.write(process.cwd())"',
      path.join(os.tmpdir(), '.'),
      15_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.replaceAll('\\', '/')).toContain(os.tmpdir().replaceAll('\\', '/'));
  });
});
