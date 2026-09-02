/**
 * Edge-case tests for verification-context.ts functions not covered by the
 * main test file.  Tests here focus on the standalone helpers and edge paths.
 *
 * Coverage targets:
 * - normalizeBaseCommand: normalizes paths, extensions, and casing
 * - extractBaseCommand: extracts from quoted commands
 * - parseCommandArguments: handles quotes, whitespace, unterminated strings
 * - buildAllowlist: prefix semantics (+/-, mix with block)
 * - validateCommand: empty command, newlines, blocked commands, allowAll,
 *   env expansion on allowAll
 * - SHELL_OPERATOR_RE edge cases
 * - ENV_EXPANSION_RE edge cases
 * - parseGitNameStatus: edge cases (empty, tab-separated, unknown status)
 * - parseGitNumstat: malformed lines, missing parts
 * - debug helpers: isTestCount, isTestJsonObject
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  normalizeBaseCommand,
  parseGitNameStatus,
  parseGitNumstat,
  SHELL_OPERATOR_RE,
  validateCommand,
} from '../src/verification/verification-context.js';

// ── normalizeBaseCommand ─────────────────────────────────────────────────

describe('normalizeBaseCommand', () => {
  it('strips directory path prefix', () => {
    expect(normalizeBaseCommand('/usr/bin/node')).toBe('node');
    expect(normalizeBaseCommand('C:\\Program Files\\nodejs\\node.exe')).toBe('node');
    expect(normalizeBaseCommand('./node_modules/.bin/vitest')).toBe('vitest');
  });

  it('strips .exe/.cmd/.bat/.com suffix', () => {
    expect(normalizeBaseCommand('node.exe')).toBe('node');
    expect(normalizeBaseCommand('NODE.CMD')).toBe('node');
    expect(normalizeBaseCommand('test.bat')).toBe('test');
    expect(normalizeBaseCommand('tool.COM')).toBe('tool');
  });

  it('lowercases the result', () => {
    expect(normalizeBaseCommand('NODE')).toBe('node');
    expect(normalizeBaseCommand('Git')).toBe('git');
    expect(normalizeBaseCommand('PWD')).toBe('pwd');
  });

  it('returns unchanged for simple bare words', () => {
    expect(normalizeBaseCommand('node')).toBe('node');
    expect(normalizeBaseCommand('pwd')).toBe('pwd');
  });
});

// ── extractBaseCommand ───────────────────────────────────────────────────

describe('extractBaseCommand', () => {
  it('extracts the first word from a simple command', () => {
    expect(extractBaseCommand('node script.js')).toBe('node');
    expect(extractBaseCommand('pwd')).toBe('pwd');
  });

  it('returns empty for empty string', () => {
    expect(extractBaseCommand('')).toBe('');
  });

  it('handles quoted strings', () => {
    expect(extractBaseCommand('"c:\\program files\\node\\node.exe" --version')).toBe('node');
    expect(extractBaseCommand("'./my tool' arg")).toBe('my tool');
  });

  it('returns empty when parseCommandArguments returns an error string', () => {
    expect(extractBaseCommand('echo "unterminated')).toBe('');
  });
});

// ── parseCommandArguments (via extractBaseCommand) ────────────────────────
// parseCommandArguments is a private function; tested indirectly through
// extractBaseCommand and validateCommand.

// ── buildAllowlist (tested through validateCommand) ───────────────────────

describe('validateCommand', () => {
  const defaultAllow = new Set(DEFAULT_ALLOWED_COMMANDS.map((c) => normalizeBaseCommand(c)));
  const defaultBlock = new Set(DEFAULT_BLOCKED_COMMANDS.map((c) => normalizeBaseCommand(c)));

  function makeConfig(
    overrides: Partial<{
      allow: Set<string>;
      block: Set<string>;
      allowAll: boolean;
      allowShellOperators: boolean;
    }> = {},
  ) {
    return {
      allow: overrides.allow ?? defaultAllow,
      block: overrides.block ?? defaultBlock,
      allowAll: overrides.allowAll ?? false,
      allowShellOperators: overrides.allowShellOperators ?? false,
    };
  }

  it('rejects empty command', () => {
    expect(validateCommand('', makeConfig())).toBe('Empty command.');
  });

  it('rejects command with newline', () => {
    expect(validateCommand('echo hello\nrm -rf /', makeConfig())).toContain('newline');
  });

  it('rejects command with carriage return', () => {
    expect(validateCommand('echo hello\rm -rf /', makeConfig())).toContain('newline');
  });

  it('rejects blocked commands', () => {
    expect(validateCommand('rm file.txt', makeConfig())).toContain('blocked');
    expect(validateCommand('mkdir dir', makeConfig())).toContain('blocked');
    expect(validateCommand('node script.js', makeConfig())).toContain('blocked');
    expect(validateCommand('pnpm install', makeConfig())).toContain('blocked');
  });

  it('rejects commands not in allowlist when allowAll is false', () => {
    expect(validateCommand('some_custom_tool', makeConfig())).toContain(
      'not in the verifier allowlist',
    );
  });

  it('allows commands not in blocklist when allowAll is true', () => {
    const config = makeConfig({ allowAll: true });
    expect(validateCommand('printf hello', config)).toBeNull();
  });

  it('still blocks blocked commands even with allowAll', () => {
    const config = makeConfig({ allowAll: true });
    expect(validateCommand('rm file.txt', config)).toContain('blocked');
  });

  it('allows default allowed commands', () => {
    expect(validateCommand('pwd', makeConfig())).toBeNull();
    expect(validateCommand('true', makeConfig())).toBeNull();
    expect(validateCommand('false', makeConfig())).toBeNull();
  });

  it('rejects shell operators by default', () => {
    expect(validateCommand('echo hello && rm -rf /', makeConfig())).toContain('shell operators');
    expect(validateCommand('echo hello | grep test', makeConfig())).toContain('shell operators');
    expect(validateCommand('echo hello $(whoami)', makeConfig())).toContain('shell operators');
    expect(validateCommand('echo hello; rm -rf /', makeConfig())).toContain('shell operators');
  });

  it('allows shell operators when allowShellOperators is true', () => {
    const config = makeConfig({ allowShellOperators: true });
    // But it also needs to be allowed/blocked correctly
    // pwd is in the allowlist
    expect(validateCommand('pwd && pwd', config)).toBeNull();
  });

  it('rejects env expansion even with allowShellOperators', () => {
    const config = makeConfig({ allowShellOperators: true });
    expect(validateCommand('echo $HOME', config)).toContain('environment-variable');
    expect(validateCommand('echo %PATH%', config)).toContain('environment-variable');
    expect(validateCommand('echo !NAME!', config)).toContain('environment-variable');
  });

  it('strips caret on Windows for operator detection', () => {
    // The caret ^ is an escape char on Windows cmd, stripped before test
    const config = makeConfig();
    // `echo hello ^& rm -rf /` — after caret removal: `echo hello & rm -rf /`
    // The `&` should be caught
    expect(validateCommand('echo hello ^& rm -rf /', config)).toContain('shell operators');
  });
});

// ── SHELL_OPERATOR_RE ────────────────────────────────────────────────────

describe('SHELL_OPERATOR_RE', () => {
  it('matches &&', () => {
    expect(SHELL_OPERATOR_RE.test('cmd1 && cmd2')).toBe(true);
  });

  it('matches ||', () => {
    expect(SHELL_OPERATOR_RE.test('cmd1 || cmd2')).toBe(true);
  });

  it('matches semicolon', () => {
    expect(SHELL_OPERATOR_RE.test('cmd1; cmd2')).toBe(true);
  });

  it('matches pipe', () => {
    expect(SHELL_OPERATOR_RE.test('cmd1 | cmd2')).toBe(true);
  });

  it('matches backtick', () => {
    expect(SHELL_OPERATOR_RE.test('echo `whoami`')).toBe(true);
  });

  it('matches $()', () => {
    expect(SHELL_OPERATOR_RE.test('$(cmd)')).toBe(true);
    expect(SHELL_OPERATOR_RE.test(`\${var}`)).toBe(true);
  });

  it('matches angle brackets', () => {
    expect(SHELL_OPERATOR_RE.test('cmd > file')).toBe(true);
    expect(SHELL_OPERATOR_RE.test('cmd < file')).toBe(true);
  });

  it('matches ampersand', () => {
    expect(SHELL_OPERATOR_RE.test('cmd &')).toBe(true);
  });

  it('matches newline', () => {
    expect(SHELL_OPERATOR_RE.test('cmd1\ncmd2')).toBe(true);
  });

  it('does NOT match safe commands', () => {
    expect(SHELL_OPERATOR_RE.test('pwd')).toBe(false);
    expect(SHELL_OPERATOR_RE.test('test -e file.txt')).toBe(false);
    expect(SHELL_OPERATOR_RE.test('echo hello')).toBe(false);
  });
});

// ── ENV_EXPANSION_RE (tested through validateCommand) ─────────────────────
// ENV_EXPANSION_RE is not directly exported; tested indirectly via
// validateCommand's env expansion rejection tests above.

// ── parseGitNameStatus ────────────────────────────────────────────────────

describe('parseGitNameStatus', () => {
  it('parses added, modified, deleted files', () => {
    const result = parseGitNameStatus('M\tsrc/modified.ts\nA\tsrc/created.ts\nD\tsrc/deleted.ts\n');
    expect(result.get('src/modified.ts')).toBe('modify');
    expect(result.get('src/created.ts')).toBe('create');
    expect(result.get('src/deleted.ts')).toBe('delete');
  });

  it('handles copy and rename status as modify', () => {
    const result = parseGitNameStatus('C50\tsrc/copied.ts\nR100\tsrc/renamed.ts\n');
    expect(result.get('src/copied.ts')).toBe('modify');
    expect(result.get('src/renamed.ts')).toBe('modify');
  });

  it('handles added files with extra score prefix', () => {
    const result = parseGitNameStatus('A100\tsrc/new.ts\n');
    expect(result.get('src/new.ts')).toBe('create');
  });

  it('handles empty output', () => {
    const result = parseGitNameStatus('');
    expect(result.size).toBe(0);
  });

  it('handles multiple tabs (file path with spaces)', () => {
    const result = parseGitNameStatus('M\tsrc/path with spaces.ts\n');
    expect(result.get('src/path with spaces.ts')).toBe('modify');
  });
});

// ── parseGitNumstat ──────────────────────────────────────────────────────

describe('parseGitNumstat', () => {
  it('parses normal numstat lines', () => {
    const result = parseGitNumstat('5\t2\tsrc/file.ts\n3\t0\tsrc/new.ts\n0\t9\tsrc/deleted.ts\n');
    expect(result).toEqual([
      { path: 'src/file.ts', operation: 'modify', linesAdded: 5, linesRemoved: 2 },
      { path: 'src/new.ts', operation: 'modify', linesAdded: 3, linesRemoved: 0 },
      { path: 'src/deleted.ts', operation: 'modify', linesAdded: 0, linesRemoved: 9 },
    ]);
  });

  it('uses name-status operations when provided', () => {
    const operations = new Map([
      ['src/new.ts', 'create' as const],
      ['src/deleted.ts', 'delete' as const],
    ]);
    const result = parseGitNumstat('3\t0\tsrc/new.ts\n0\t9\tsrc/deleted.ts\n', operations);
    expect(result).toEqual([
      { path: 'src/new.ts', operation: 'create', linesAdded: 3, linesRemoved: 0 },
      { path: 'src/deleted.ts', operation: 'delete', linesAdded: 0, linesRemoved: 9 },
    ]);
  });

  it('handles malformed lines with fewer than 3 parts', () => {
    const result = parseGitNumstat('5\t2\tsrc/file.ts\nincomplete\n3\t0\n');
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('src/file.ts');
  });

  it('handles non-numeric counts gracefully', () => {
    const result = parseGitNumstat('abc\tdef\tsrc/file.ts\n');
    expect(result).toEqual([
      { path: 'src/file.ts', operation: 'modify', linesAdded: 0, linesRemoved: 0 },
    ]);
  });

  it('handles empty output', () => {
    expect(parseGitNumstat('')).toEqual([]);
  });

  it('handles blank lines', () => {
    expect(parseGitNumstat('   \n5\t2\tsrc/file.ts\n\n')).toHaveLength(1);
  });
});

// ── DEFAULT_ALLOWED_COMMANDS / DEFAULT_BLOCKED_COMMANDS ──────────────────

describe('DEFAULT_ALLOWED_COMMANDS', () => {
  it('contains pwd, true, false, test', () => {
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('pwd');
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('true');
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('false');
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('test');
  });
});

describe('DEFAULT_BLOCKED_COMMANDS', () => {
  it('contains dangerous utilities', () => {
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('rm');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('node');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('pnpm');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('bash');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('curl');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('sudo');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('python');
  });
});
