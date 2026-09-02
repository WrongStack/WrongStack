/**
 * Supplementary tests for runtime helper — targeting uncovered branches.
 */
import { describe, expect, it } from 'vitest';
import {
  type LanguageRuntime,
  resolveRunnerCommand,
  sanitizeRunnerPath,
  runRunnerCommand,
  probeRunner,
  locateRunnerEntry,
} from '../src/runtime/index.js';

const TYPESCRIPT_RUNTIME: LanguageRuntime = {
  id: 'typescript',
  packageManager: 'pnpm',
  executable: 'tsc',
  allowedFlags: new Set(['--noEmit', '--pretty', '--pretty=false']),
  subcommands: ['exec'],
  defaultCommand: 'pnpm exec tsc --noEmit',
};

describe('runtime helper extra coverage', () => {
  describe('sanitizeRunnerPath', () => {
    it('returns null for empty string', () => {
      expect(sanitizeRunnerPath('')).toBeNull();
    });

    it('returns null for leading-dash values', () => {
      expect(sanitizeRunnerPath('--option')).toBeNull();
    });

    it('accepts cwd-relative paths', () => {
      const result = sanitizeRunnerPath('src/test.ts');
      expect(result).not.toBeNull();
      expect(result).toContain('src');
    });

    it('rejects paths outside the project', () => {
      const result = sanitizeRunnerPath('/etc/passwd', { projectRoot: '/tmp/project' });
      expect(result).toBeNull();
    });
  });

  describe('resolveRunnerCommand edge cases', () => {
    it('returns null for empty command', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, '')).toBeNull();
    });

    it('returns null for whitespace-only command', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, '   ')).toBeNull();
    });

    it('returns null for bare launcher without executable', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'pnpm')).toBeNull();
    });

    it('returns null for non-matching head token', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'node tsc')).toBeNull();
    });

    it('rejects launcher+exec path when rest has unallowed flags', () => {
      const runtime: LanguageRuntime = {
        id: 'typescript',
        packageManager: 'npm',
        executable: 'tsc',
        allowedFlags: new Set(['--noEmit']),
        subcommands: [],
        defaultCommand: 'npm tsc --noEmit',
      };
      expect(resolveRunnerCommand(runtime, 'npm tsc --evil')).toBeNull();
    });

    it('rejects launcher+subcommand+exec when rest has unallowed flags', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'pnpm exec tsc --evil')).toBeNull();
    });

    it('rejects launcher+subcommand when executable does not match', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'pnpm exec node')).toBeNull();
    });

    it('rejects absolute path with mismatched basename', () => {
      const absPath = '/usr/local/bin/node';
      expect(
        resolveRunnerCommand(TYPESCRIPT_RUNTIME, `${absPath} tsc`, { projectRoot: '/usr/local' }),
      ).toBeNull();
    });

    it('rejects absolute path outside project', () => {
      expect(
        resolveRunnerCommand(TYPESCRIPT_RUNTIME, '/usr/bin/tsc --noEmit', {
          projectRoot: process.cwd(),
        }),
      ).toBeNull();
    });
  });

  describe('runRunnerCommand', () => {
    it('returns spawnError for empty argv', async () => {
      const result = await runRunnerCommand([], { cwd: process.cwd(), timeoutMs: 1000 });
      expect(result.spawnError).toBe(true);
      expect(result.stderr).toContain('empty argv');
    });

    it('returns spawnError for cwd outside project', async () => {
      const result = await runRunnerCommand(['node', '-e', 'console.log("hi")'], {
        cwd: '/nonexistent',
        timeoutMs: 1000,
        projectRoot: process.cwd(),
      });
      expect(result.spawnError).toBe(true);
      expect(result.stderr).toContain('outside project');
    });
  });

  describe('probeRunner', () => {
    it('returns false when runner command cannot be resolved', async () => {
      const runtime: LanguageRuntime = {
        id: 'typescript',
        packageManager: 'pnpm',
        executable: 'nonexistent-tool-xyz',
        allowedFlags: null,
        subcommands: ['exec'],
        defaultCommand: 'pnpm exec nonexistent-tool-xyz --version',
      };
      const result = await probeRunner(runtime, '--version', {
        cwd: process.cwd(),
        timeoutMs: 1000,
      });
      expect(result).toBe(false);
    });

    it('returns false when resolveRunnerCommand succeeds but probe fails', async () => {
      const runtime: LanguageRuntime = {
        id: 'typescript',
        packageManager: 'none' as never,
        executable: 'nonexistent-cmd-999',
        allowedFlags: null,
        subcommands: [],
        defaultCommand: 'nonexistent-cmd-999 --version',
      };
      const result = await probeRunner(runtime, '--version', {
        cwd: process.cwd(),
        timeoutMs: 1000,
      });
      expect(result).toBe(false);
    });
  });

  describe('locateRunnerEntry', () => {
    it('returns null when runner binary is not found', () => {
      const runtime: LanguageRuntime = {
        id: 'typescript',
        packageManager: 'pnpm',
        executable: 'nonexistent-binary-xyz-999',
        allowedFlags: null,
        subcommands: ['exec'],
        defaultCommand: 'pnpm exec nonexistent-binary-xyz-999',
      };
      const result = locateRunnerEntry(runtime, process.cwd());
      expect(result).toBeNull();
    });
  });
});
