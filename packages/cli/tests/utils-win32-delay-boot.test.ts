/**
 * Tests for CLI utility modules: win32-cmd, delay-format, and boot-config.
 */
import { describe, expect, it } from 'vitest';
import { bootConfig } from '../src/boot-config.js';
import { formatDelay } from '../src/utils/delay-format.js';
import { buildWin32CmdShimInvocation } from '../src/utils/win32-cmd.js';

// ============================================================================
// win32-cmd.ts
// ============================================================================

describe('buildWin32CmdShimInvocation', () => {
  it('builds a cmd invocation with quoted command', () => {
    const result = buildWin32CmdShimInvocation('node');
    expect(result.command).toBe(process.env['COMSPEC'] ?? 'cmd.exe');
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.args[0]).toBe('/d');
    expect(result.args[1]).toBe('/c');
    expect(result.args[2]).toContain('call');
    expect(result.args[2]).toContain('"node"');
  });

  it('includes extra args wrapped in quotes', () => {
    const result = buildWin32CmdShimInvocation('node', ['run', 'test']);
    expect(result.args[2]).toBe('call "node" "run" "test"');
  });

  it('throws on metacharacter in command', () => {
    expect(() => buildWin32CmdShimInvocation('node&echo')).toThrow('win32 cmd shim');
    expect(() => buildWin32CmdShimInvocation('node|echo')).toThrow('win32 cmd shim');
    expect(() => buildWin32CmdShimInvocation('node>file')).toThrow('win32 cmd shim');
    expect(() => buildWin32CmdShimInvocation('node<file')).toThrow('win32 cmd shim');
  });

  it('throws on metacharacter in arguments', () => {
    expect(() => buildWin32CmdShimInvocation('node', ['arg&'])).toThrow('win32 cmd shim');
  });

  it('accepts safe arguments without throwing', () => {
    const result = buildWin32CmdShimInvocation('node', ['--version', '-e', 'test']);
    expect(result.args[2]).toBe('call "node" "--version" "-e" "test"');
  });

  it('handles empty args array', () => {
    const result = buildWin32CmdShimInvocation('npm', []);
    expect(result.args[2]).toBe('call "npm"');
  });
});

// ============================================================================
// delay-format.ts
// ============================================================================

describe('formatDelay', () => {
  it('returns "disabled" for 0', () => {
    expect(formatDelay(0)).toBe('disabled');
  });

  it('returns seconds for sub-minute values', () => {
    expect(formatDelay(1000)).toBe('1s');
    expect(formatDelay(30_000)).toBe('30s');
    expect(formatDelay(59_000)).toBe('59s');
  });

  it('returns minutes for 60k+ ms', () => {
    expect(formatDelay(60_000)).toBe('1m');
    expect(formatDelay(120_000)).toBe('2m');
    expect(formatDelay(3_600_000)).toBe('60m');
  });
});

// ============================================================================
// boot-config.ts
// ============================================================================

describe('bootConfig', () => {
  it('returns paths, config, and vault when booted without webui flag', async () => {
    const result = await bootConfig({});
    expect(result.paths).toBeDefined();
    expect(result.paths.cwd).toBeDefined();
    expect(result.paths.projectRoot).toBeDefined();
    expect(result.paths.userHome).toBeDefined();
    expect(result.paths.wpaths).toBeDefined();
    expect(result.paths.pathResolver).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.vault).toBeDefined();
  });

  it('passes skipIdentityValidation when --webui flag is present', async () => {
    // This should still boot successfully even with the flag
    const result = await bootConfig({ webui: true });
    expect(result.config).toBeDefined();
    expect(result.paths).toBeDefined();
  });
});
