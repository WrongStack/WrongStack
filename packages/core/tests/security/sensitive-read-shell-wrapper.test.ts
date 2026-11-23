import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import {
  isSensitiveReadCall,
  shellCommandReadsSensitivePath,
} from '../../src/security/permission-sensitive-read.js';

const bashTool = {
  name: 'bash',
  capabilities: [ToolCapabilities.SHELL_ARBITRARY],
} as unknown as Tool;

function shellReads(command: string): boolean {
  return isSensitiveReadCall(bashTool, { command });
}

describe('sensitive-read detection through shell wrappers', () => {
  it('sees a sensitive read inside a quoted nested command', () => {
    expect(shellReads('cat .env')).toBe(true);
    expect(shellReads('powershell -Command "Get-Content .env"')).toBe(true);
    expect(shellReads("bash -c 'cat .env'")).toBe(true);
  });

  it('sees a sensitive path passed to find -exec', () => {
    expect(shellReads('find . -name .env -exec cat {} \\;')).toBe(true);
  });

  it('keeps safe reads and non-read commands non-sensitive', () => {
    expect(shellReads('cat safe.txt')).toBe(false);
    expect(shellReads('echo .env')).toBe(false);
    expect(shellCommandReadsSensitivePath('ls -la')).toBe(false);
  });
});
