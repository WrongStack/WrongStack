import * as os from 'node:os';
import type { ToolStreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { pwshTool } from '../src/pwsh.js';
import { mkSandbox, newSignal } from './fixtures.js';

const isWin = os.platform() === 'win32';

describe('pwshTool', () => {
  it('has correct metadata and prompt description', () => {
    expect(pwshTool.name).toBe('pwsh');
    expect(pwshTool.permission).toBe('confirm');
    expect(pwshTool.mutating).toBe(true);
    expect(pwshTool.riskTier).toBe('destructive');
    expect(pwshTool.description).toContain('Execute a PowerShell command');
    expect(pwshTool.usageHint).toContain('ConstrainedLanguage');
  });

  it('runs a simple PowerShell command and captures output', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'Write-Output "hello-from-pwsh"' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.exit_code).toBe(0);
      expect(out.output.trim()).toContain('hello-from-pwsh');
      expect(out.timed_out).toBe(false);
    } finally {
      await sb.cleanup();
    }
  });

  it('handles exit codes properly', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'exit 42' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.exit_code).toBe(42);
      expect(out.output).toContain('[exit code: 42]');
    } finally {
      await sb.cleanup();
    }
  });

  it('rejects on empty command', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        pwshTool.execute({ command: '' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow();
    } finally {
      await sb.cleanup();
    }
  });

  it('supports streaming execution', async () => {
    const sb = await mkSandbox();
    try {
      expect(typeof pwshTool.executeStream).toBe('function');
      const events: ToolStreamEvent[] = [];
      for await (const ev of pwshTool.executeStream!(
        { command: 'Write-Output "stream-test"' },
        sb.ctx,
        { signal: newSignal() },
      )) {
        events.push(ev);
      }
      const finals = events.filter((e) => e.type === 'final');
      expect(finals).toHaveLength(1);
      expect(finals[0].type === 'final' && finals[0].output.output).toContain('stream-test');
    } finally {
      await sb.cleanup();
    }
  });

  it('defines selection boundaries for tool router', () => {
    expect(pwshTool.selection?.useInstead).toContain('exec');
  });

  it('records side effect upon execution', async () => {
    const sb = await mkSandbox();
    const sideEffects: unknown[] = [];
    sb.ctx.recordSideEffect = (effect) => sideEffects.push(effect);
    try {
      await pwshTool.execute(
        { command: 'Write-Output "side-effect-test"' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(sideEffects).toHaveLength(1);
      expect(sideEffects[0]).toMatchObject({ toolName: 'pwsh', risk: 'shell' });
    } finally {
      await sb.cleanup();
    }
  });

  it('diagnoses bashisms when a command fails with POSIX syntax', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'export FOO=bar; exit 1' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.output).toContain('[wrongstack]');
      expect(out.output).toContain('$env:NAME');
    } finally {
      await sb.cleanup();
    }
  });
});
