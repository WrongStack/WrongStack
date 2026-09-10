/**
 * Tests for kanban verification-context.ts — pure command validation
 * functions: normalizeBaseCommand, extractBaseCommand, validateCommand.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_COMMANDS,
  extractBaseCommand,
  normalizeBaseCommand,
  parseConstrainedPnpmExec,
  validateCommand,
} from '../src/verification/verification-context.js';

// ── normalizeBaseCommand ─────────────────────────────────────────────────────

describe('normalizeBaseCommand', () => {
  it('strips directory paths', () => {
    expect(normalizeBaseCommand('/usr/bin/git')).toBe('git');
    expect(normalizeBaseCommand('C:\\Program Files\\Git\\bin\\git.exe')).toBe('git');
    expect(normalizeBaseCommand('./node_modules/.bin/vitest')).toBe('vitest');
  });

  it('strips executable extensions', () => {
    expect(normalizeBaseCommand('git.exe')).toBe('git');
    expect(normalizeBaseCommand('npm.cmd')).toBe('npm');
    expect(normalizeBaseCommand('pnpm.bat')).toBe('pnpm');
    expect(normalizeBaseCommand('node.com')).toBe('node');
  });

  it('lowercases the command', () => {
    expect(normalizeBaseCommand('Git')).toBe('git');
    expect(normalizeBaseCommand('NPM.CMD')).toBe('npm');
  });

  it('handles bare command names', () => {
    expect(normalizeBaseCommand('pwd')).toBe('pwd');
    expect(normalizeBaseCommand('true')).toBe('true');
  });
});

// ── extractBaseCommand ───────────────────────────────────────────────────────

describe('extractBaseCommand', () => {
  it('extracts the first token as base command', () => {
    expect(extractBaseCommand('git status')).toBe('git');
    expect(extractBaseCommand('npm run build')).toBe('npm');
  });

  it('normalizes the extracted command', () => {
    expect(extractBaseCommand('/usr/bin/git status')).toBe('git');
    expect(extractBaseCommand('node.exe app.js')).toBe('node');
  });

  it('returns empty string for empty input', () => {
    expect(extractBaseCommand('')).toBe('');
  });

  it('handles quoted arguments', () => {
    expect(extractBaseCommand('git commit -m "hello world"')).toBe('git');
  });

  it('returns empty for unterminated quotes', () => {
    expect(extractBaseCommand('git commit -m "unterminated')).toBe('');
  });
});

// ── constrained pnpm exec ───────────────────────────────────────────────────

describe('parseConstrainedPnpmExec', () => {
  it('accepts only the recorded local Vitest and no-emit TypeScript forms', () => {
    expect(
      parseConstrainedPnpmExec([
        'PNPM',
        'EXEC',
        'VITEST',
        'run',
        '--root',
        '.',
        'packages/core/tests/security/permission-policy.test.ts',
      ]),
    ).toEqual({
      executable: 'vitest',
      args: ['run', '--root', '.', 'packages/core/tests/security/permission-policy.test.ts'],
    });
    expect(
      parseConstrainedPnpmExec([
        'pnpm',
        'exec',
        'tsc',
        '--noEmit',
        '--project',
        'packages/core/tsconfig.json',
      ]),
    ).toEqual({
      executable: 'tsc',
      args: ['--noEmit', '--project', 'packages/core/tsconfig.json'],
    });
  });

  it.each([
    ['pnpm install'],
    ['pnpm run test'],
    ['pnpm exec eslint .'],
    ['pnpm exec vitest'],
    ['pnpm exec vitest --config local.ts'],
    ['pnpm exec vitest run ../outside.test.ts'],
    ['pnpm exec vitest run x&calc.test.ts'],
    ['pnpm exec tsc --project packages/core/tsconfig.json'],
    ['pnpm exec tsc --noEmit --project C:outside/tsconfig.json'],
    ['pnpm exec tsc --noEmit --project ../outside/tsconfig.json'],
  ])('rejects unsafe or unsupported form %s', (command) => {
    expect(parseConstrainedPnpmExec(command.split(' '))).toEqual(expect.any(String));
  });
});

// ── validateCommand ──────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<{
    allow: Set<string>;
    block: Set<string>;
    allowAll: boolean;
    allowShellOperators: boolean;
  }> = {},
) {
  return {
    allow: new Set(DEFAULT_ALLOWED_COMMANDS.map(normalizeBaseCommand)),
    block: new Set(DEFAULT_BLOCKED_COMMANDS.map(normalizeBaseCommand)),
    allowAll: false,
    ...overrides,
  };
}

describe('validateCommand', () => {
  it('allows default allowed commands', () => {
    expect(validateCommand('pwd', makeConfig())).toBeNull();
    expect(validateCommand('true', makeConfig())).toBeNull();
    expect(validateCommand('false', makeConfig())).toBeNull();
  });

  it('admits only constrained pnpm exec forms through the public validation boundary', () => {
    expect(
      validateCommand(
        'pnpm exec vitest run --root . packages/core/tests/security/permission-policy.test.ts',
        makeConfig(),
      ),
    ).toBeNull();
    expect(
      validateCommand('pnpm exec tsc --noEmit --project packages/core/tsconfig.json', makeConfig()),
    ).toBeNull();
    expect(
      validateCommand(
        'pnpm exec vitest run x&calc.test.ts',
        makeConfig({ allowShellOperators: true }),
      ),
    ).toContain('requires one or more project-relative');
  });

  it('rejects empty commands', () => {
    expect(validateCommand('', makeConfig())).toBe('Empty command.');
  });

  it('rejects blocked commands', () => {
    const result = validateCommand('rm -rf /', makeConfig());
    expect(result).not.toBeNull();
    expect(result).toContain('blocked');
  });

  it('rejects shell operators by default', () => {
    const result = validateCommand('pwd && rm -rf /', makeConfig());
    expect(result).not.toBeNull();
  });

  it('allows shell operators when explicitly enabled', () => {
    const config = makeConfig({ allowShellOperators: true, allowAll: true });
    expect(validateCommand('pwd && true', config)).toBeNull();
  });

  it('rejects unknown commands when allowAll is false', () => {
    const result = validateCommand('curl http://evil.com', makeConfig());
    expect(result).not.toBeNull();
  });

  it('allows unknown commands when allowAll is true', () => {
    const config = makeConfig({ allowAll: true });
    // 'myapp' is not in the default blocklist
    expect(validateCommand('myapp --flag value', config)).toBeNull();
  });

  it('still blocks blocked commands even with allowAll', () => {
    const config = makeConfig({ allowAll: true });
    const result = validateCommand('rm -rf /', config);
    expect(result).not.toBeNull();
  });

  it('rejects environment variable expansion', () => {
    const result = validateCommand('echo $HOME', makeConfig({ allowAll: true }));
    expect(result).not.toBeNull();
  });

  it('rejects Windows-style env expansion', () => {
    const result = validateCommand('echo %PATH%', makeConfig({ allowAll: true }));
    expect(result).not.toBeNull();
  });
});

// ── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_ALLOWED_COMMANDS includes safe commands', () => {
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('pwd');
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('true');
    expect(DEFAULT_ALLOWED_COMMANDS).toContain('false');
  });

  it('DEFAULT_BLOCKED_COMMANDS includes dangerous commands', () => {
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('rm');
    expect(DEFAULT_BLOCKED_COMMANDS).toContain('kill');
  });
});
