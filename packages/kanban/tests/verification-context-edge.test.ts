/**
 * Edge-case tests for verification-context.ts functions not covered by the
 * main test file.  Tests here focus on the standalone helpers and edge paths.
 *
 * Coverage targets:
 * - normalizeBaseCommand: normalizes paths, extensions, and casing
 * - extractBaseCommand: extracts from quoted strings
 * - parseCommandArguments: handles quotes, whitespace, unterminated strings
 * - buildAllowlist: prefix semantics (+/-, mix with block)
 * - validateCommand: empty command, newlines, blocked commands, allowAll,
 *   env expansion on allowAll
 * - SHELL_OPERATOR_RE edge cases
 * - ENV_EXPANSION_RE edge cases
 * - parseGitNameStatus: edge cases (empty, tab-separated, unknown status)
 * - parseGitNumstat: malformed lines, missing parts
 * - debug helpers: isTestCount, isTestJsonObject
 * - resolveConfiguredExecutable / detectTestRunner: accepts legal in-root
 *   first segments that merely BEGIN with '..' (e.g. ..hidden/bin.js)
 *   instead of misreading them as parent traversals (round-44 regression).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import { tryParseTestJson } from '../src/verification/test-output-parser.js';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  normalizeBaseCommand,
  parseGitNameStatus,
  parseGitNumstat,
  SHELL_OPERATOR_RE,
  VerificationContext,
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
    }> = {},
  ) {
    return {
      allow: overrides.allow ?? defaultAllow,
      block: overrides.block ?? defaultBlock,
      allowAll: overrides.allowAll ?? false,
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

  // The `allowShellOperators` opt-out was removed: no configuration admits an
  // operator, because an allowlisted command can resolve to a Windows `.cmd`
  // shim that spawns with `shell: true`.
  it('rejects shell operators under every configuration', () => {
    expect(validateCommand('pwd && pwd', makeConfig())).toContain('shell operators');
    expect(validateCommand('pwd && pwd', makeConfig({ allowAll: true }))).toContain(
      'shell operators',
    );
  });

  it('rejects env expansion independently of the operator gate', () => {
    const config = makeConfig({ allowAll: true });
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

  it('parses CRLF line endings and tabbed non-rename file paths across name-status and numstat', () => {
    const ops = parseGitNameStatus('A\tsrc/win.ts\r\nA\tsrc/tab\tname.ts\r\n');
    const diff = parseGitNumstat('5\t1\tsrc/win.ts\r\n2\t0\tsrc/tab\tname.ts\r\n', ops);
    expect(diff).toEqual([
      { path: 'src/win.ts', operation: 'create', linesAdded: 5, linesRemoved: 1 },
      { path: 'src/tab\tname.ts', operation: 'create', linesAdded: 2, linesRemoved: 0 },
    ]);
  });

  it('aggregates testResults assertion counts and rejects negative top-level counts in tryParseTestJson', () => {
    const suiteOnly = tryParseTestJson(
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              { status: 'passed' },
              { status: 'passed' },
              { status: 'failed' },
              { status: 'pending' },
            ],
          },
        ],
      }),
      'suite.test.ts',
    );
    expect(suiteOnly).toEqual({
      testPattern: 'suite.test.ts',
      passed: 2,
      failed: 1,
      skipped: 1,
    });

    const negativeCounts = tryParseTestJson(
      JSON.stringify({
        testResults: [],
        numPassedTests: -4,
        numFailedTests: -1,
      }),
      'neg.test.ts',
    );
    expect(negativeCounts).toEqual({
      testPattern: 'neg.test.ts',
      passed: 0,
      failed: 0,
      skipped: 0,
    });
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

// ── resolveConfiguredExecutable / detectTestRunner dot-dot regression ────
// Round-44 regression: the binary-resolution predicates at lines 754 and
// 824 of verification-context.ts used the loose
// `path.relative(packageDir, entry).startsWith('..')`, which misread
// legal in-root first segments whose NAME merely begins with '..'
// (e.g. `..hidden/bin.js`) as parent traversals and rejected them,
// forcing a fallthrough to the .bin shim or PATH. The canonical
// predicate (`rel === '..' || rel.startsWith('..' + sep) ||
// isAbsolute(rel)`) accepts such legal names while still blocking
// real `../` climbs. Wave 3 fixed the containment helpers at lines
// 521/525/530 but explicitly left the binary-resolution sites
// untouched ("unrelated to command grammar"); this test pins the
// binary-resolution path.

describe('round-44: resolveConfiguredExecutable accepts legal ..-prefixed in-root bin', () => {
  const roots: string[] = [];

  function fixture(): { board: KanbanBoard; task: KanbanTask } {
    const now = '2026-09-19T00:00:00.000Z';
    const task: KanbanTask = {
      id: 'task-1',
      title: 'Verify dotdot-bin regression',
      columnId: 'review',
      order: 0,
      priority: 'high',
      status: 'review',
      createdAt: now,
      updatedAt: now,
    };
    const board: KanbanBoard = {
      id: 'board-1',
      title: 'Dotdot bin regression',
      columns: [{ id: 'review', title: 'Review', order: 0, wipLimit: 0 }],
      tasks: [task],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    return { board, task };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('resolves a local bin under a ..hidden/ directory (legal in-root first segment)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r44-edge-dotdot-bin-'));
    roots.push(root);

    // Minimal project package.json so createRequire resolves.
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r44-edge-fixture', version: '0.0.0' }),
      'utf8',
    );

    // Local package whose bin points to a file under a directory whose
    // first segment begins with '..' — a legal in-root name, NOT a
    // parent traversal. The script writes a marker so we can assert
    // the resolved binary actually executed (not a fallback).
    const pkgDir = join(root, 'node_modules', 'r44tool');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'r44tool',
        version: '0.0.0',
        bin: { r44tool: `..hidden${sep}r44tool.js` },
      }),
      'utf8',
    );
    const binDir = join(pkgDir, '..hidden');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'r44tool.js'), "process.stdout.write('r44-edge-ok');\n", 'utf8');

    const { board, task } = fixture();
    const ctx = new VerificationContext({
      projectRoot: root,
      board,
      task,
      commandAllowlist: { allowedCommands: ['r44tool'] },
    });

    const result = await ctx.runCommand('r44tool');

    // Pre-fix: the loose predicate rejected the ..hidden/ bin and
    // fell through to node_modules/.bin/r44tool (which we did NOT
    // create), producing `rejected: true` with stderr starting with
    // "Could not resolve r44tool.".
    // Post-fix: the canonical predicate accepts the ..hidden/ bin
    // and spawns it, producing stdout 'r44-edge-ok'.
    expect(result.rejected).not.toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('r44-edge-ok');
  }, 15_000);

  it('strips UTF-8 BOM from package.json in detectTestRunner (F468)', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { detectTestRunner } = await import('../src/verification/verification-executables.js');
    const root = await mkdtemp(join(tmpdir(), 'kanban-bom-runner-'));
    roots.push(root);
    await mkdir(join(root, 'node_modules', 'jest', 'bin'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'jest', 'package.json'),
      JSON.stringify({ name: 'jest', bin: { jest: 'bin/jest.js' } }),
      'utf8',
    );
    await writeFile(join(root, 'node_modules', 'jest', 'bin', 'jest.js'), '// jest\n', 'utf8');
    await mkdir(join(root, 'node_modules', 'vitest'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'vitest', 'package.json'),
      JSON.stringify({ name: 'vitest', bin: { vitest: 'vitest.mjs' } }),
      'utf8',
    );
    await writeFile(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// vitest\n', 'utf8');
    await writeFile(
      join(root, 'package.json'),
      `\uFEFF${JSON.stringify({ name: 'app', scripts: { test: 'jest' } })}`,
      'utf8',
    );
    const runner = await detectTestRunner(root);
    expect(runner?.args.some((a) => a.includes('jest'))).toBe(true);
  });
});
