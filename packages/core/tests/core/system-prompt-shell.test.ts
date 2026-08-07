import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultSystemPromptBuilder,
  effectiveShell,
  shellGuidanceBlock,
} from '../../src/core/system-prompt-builder.js';
import type { Tool } from '../../src/types/tool.js';

const bashTool: Tool = {
  name: 'bash',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return 'ok';
  },
};

describe('effectiveShell', () => {
  it('is posix on non-Windows regardless of WRONGSTACK_SHELL', () => {
    expect(effectiveShell('linux', undefined)).toBe('posix');
    expect(effectiveShell('darwin', 'pwsh')).toBe('posix');
  });

  it('maps the pinned WRONGSTACK_SHELL on win32 (suffix/case-insensitive)', () => {
    expect(effectiveShell('win32', 'pwsh')).toBe('pwsh');
    expect(effectiveShell('win32', 'PWSH.exe')).toBe('pwsh');
    expect(effectiveShell('win32', 'powershell')).toBe('powershell');
    expect(effectiveShell('win32', 'powershell.exe')).toBe('powershell');
    expect(effectiveShell('win32', 'cmd')).toBe('cmd');
  });

  it('defaults to cmd on win32 when unpinned (boot did not run)', () => {
    expect(effectiveShell('win32', undefined)).toBe('cmd');
    expect(effectiveShell('win32', 'something-weird')).toBe('cmd');
  });
});

describe('shellGuidanceBlock', () => {
  it('returns empty string for posix', () => {
    expect(shellGuidanceBlock('posix', 'full')).toBe('');
    expect(shellGuidanceBlock('posix', 'short')).toBe('');
  });

  it('full PowerShell guidance covers the real-world idioms', () => {
    const g = shellGuidanceBlock('pwsh', 'full');
    expect(g).toContain('## Shell — PowerShell 7+ (pwsh)');
    expect(g).toContain('$env:NAME');
    expect(g).toContain('2>$null');
    expect(g).toContain('Get-Content path | Select-Object -Skip N -First M');
    expect(g).toContain('rg --files src | rg pattern');
    // pwsh 7 supports chaining operators.
    expect(g).toContain('Chain with `&&` / `||`');
  });

  it('warns that 5.1 lacks && / ||', () => {
    const g = shellGuidanceBlock('powershell', 'full');
    expect(g).toContain('Windows PowerShell 5.1');
    expect(g).toContain('NOT available in Windows PowerShell 5.1');
  });

  it('cmd guidance uses cmd idioms, not bash', () => {
    const g = shellGuidanceBlock('cmd', 'full');
    expect(g).toContain('## Shell — cmd.exe');
    expect(g).toContain('%NAME%');
    expect(g).toContain('2>nul');
  });

  it('short variant is a single line', () => {
    expect(shellGuidanceBlock('pwsh', 'short')).not.toContain('\n');
    expect(shellGuidanceBlock('cmd', 'short')).not.toContain('\n');
  });
});

describe('buildEnvironment — shell wiring (platform-gated)', () => {
  let tmp: string;
  const prev = process.env['WRONGSTACK_SHELL'];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-shell-'));
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env['WRONGSTACK_SHELL'];
    else process.env['WRONGSTACK_SHELL'] = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reflects the pinned shell + guidance on win32, stays bash-neutral on posix', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    if (process.platform === 'win32') {
      process.env['WRONGSTACK_SHELL'] = 'pwsh';
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [bashTool] });
      const env = blocks[2]?.text ?? '';
      expect(env).toContain('- Shell: pwsh (PowerShell 7+)');
      expect(env).toContain('## Shell — PowerShell 7+ (pwsh)');
      expect(env).toContain('Select-Object -Skip N -First M');
    } else {
      const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
      const env = blocks[2]?.text ?? '';
      // POSIX must not inject Windows shell guidance.
      expect(env).not.toContain('## Shell — ');
      expect(env).toContain('- Shell: ');
    }
  });
});
