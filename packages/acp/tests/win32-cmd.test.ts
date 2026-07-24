/**
 * Tests for the win32 cmd shim helper.
 */
import { describe, expect, it } from 'vitest';
import { buildWin32CmdShimInvocation } from '../src/win32-cmd.js';

describe('buildWin32CmdShimInvocation', () => {
  it('wraps a simple command in a cmd shim', () => {
    const result = buildWin32CmdShimInvocation('node', ['--version']);
    expect(result.command).toMatch(/cmd\.exe$/);
    expect(result.args).toContain('/d');
    expect(result.args).toContain('/c');
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  it('falls back to cmd.exe when COMSPEC is absent', () => {
    const original = process.env.COMSPEC;
    delete process.env.COMSPEC;
    try {
      expect(buildWin32CmdShimInvocation('node').command).toBe('cmd.exe');
    } finally {
      if (original === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = original;
    }
  });

  it('throws on args containing shell metacharacters', () => {
    // The & character is a shell metacharacter in cmd.exe
    expect(() => buildWin32CmdShimInvocation('node', ['arg&'])).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('cmd|test')).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('echo', ['>file'])).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('echo', ['<input'])).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('something', ['"quote'])).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('echo', ['with\nnewline'])).toThrow('metacharacter');
    expect(() => buildWin32CmdShimInvocation('echo', ['null\0char'])).toThrow('metacharacter');
  });

  it('does not throw for normal shell-safe args', () => {
    expect(() => buildWin32CmdShimInvocation('node', ['--version'])).not.toThrow();
    expect(() => buildWin32CmdShimInvocation('git', ['log', '--oneline'])).not.toThrow();
    expect(() => buildWin32CmdShimInvocation('claude', ['--acp'], ['--version'])).not.toThrow();
  });
});
