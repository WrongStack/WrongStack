import type { ToolStreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';
import { pwshTool } from '../src/pwsh.js';
import { executePwshStream } from '../src/pwsh-stream.js';
import { mkSandbox, newSignal } from './fixtures.js';

describe('pwshTool', () => {
  it('has correct metadata and prompt description', () => {
    expect(pwshTool.name).toBe('pwsh');
    expect(pwshTool.permission).toBe('confirm');
    expect(pwshTool.mutating).toBe(true);
    expect(pwshTool.riskTier).toBe('destructive');
    expect(pwshTool.description).toContain('Execute a PowerShell command');
    // The hint once described a sandbox, an escalation retry and job tools
    // that do not exist; a model following it retried refused calls forever.
    expect(pwshTool.usageHint).toContain('Not a sandbox');
    expect(pwshTool.usageHint).not.toMatch(
      /ConstrainedLanguage|sandbox_permissions|job_output|job_kill/,
    );
    expect(Object.keys(pwshTool.inputSchema.properties ?? {})).not.toContain('sandbox_permissions');
  });

  it('runs a simple PowerShell command and captures output', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute({ command: 'Write-Output "hello-from-pwsh"' }, sb.ctx, {
        signal: newSignal(),
      });
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
      const out = await pwshTool.execute({ command: 'exit 42' }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(42);
      expect(out.output).toContain('[exit code: 42]');
    } finally {
      await sb.cleanup();
    }
  });

  it('timeout_ms: 0 means no limit (was clamped to 1s)', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'Start-Sleep -Milliseconds 1800; Write-Output "slept-through"', timeout_ms: 0 },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.timed_out).toBe(false);
      expect(out.output).toContain('slept-through');
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
      const finalEvent = finals[0];
      if (finalEvent?.type !== 'final') throw new Error('expected a final stream event');
      expect((finalEvent.output as { output: string }).output).toContain('stream-test');
    } finally {
      await sb.cleanup();
    }
  });

  it('throws (not an `error` payload) when workdir escapes the project root', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        pwshTool.execute({ command: 'Write-Output "x"', workdir: '../../..' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/^pwsh: /);
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
      await pwshTool.execute({ command: 'Write-Output "side-effect-test"' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(sideEffects).toHaveLength(1);
      expect(sideEffects[0]).toMatchObject({ toolName: 'pwsh', risk: 'shell' });
    } finally {
      await sb.cleanup();
    }
  });

  it('diagnoses bashisms when a command fails with POSIX syntax', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute({ command: 'export FOO=bar; exit 1' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.output).toContain('[wrongstack]');
      expect(out.output).toContain('$env:NAME');
    } finally {
      await sb.cleanup();
    }
  });

  it('renders the world-writable caution banner for split-argument danger rules', async () => {
    // The danger assessment must see argv-shaped tokens: `chmod 777 …` is
    // classified by the cmd-gated `chmod-world-writable` rule, which can only
    // fire when the first token is treated as the program (as exec would).
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'chmod 777 .definitely-missing-proof-target' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.output).toContain('[caution: chmod with world-writable octal mode');
    } finally {
      await sb.cleanup();
    }
  });

  it('keeps phrase-scanned caution rules rendering (execution-policy bypass)', async () => {
    // `Set-ExecutionPolicy Bypass` is matched as a phrase that spans two
    // tokens; the raw-line assessment must survive the tokenized assessment.
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'Set-ExecutionPolicy Bypass -Scope Process' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.output).toContain('[caution: PowerShell execution policy bypass');
    } finally {
      await sb.cleanup();
    }
  });

  it('renders no caution banner for a benign command', async () => {
    const sb = await mkSandbox();
    try {
      const out = await pwshTool.execute(
        { command: 'Get-ChildItem .definitely-missing-proof-target' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.output).not.toContain('[caution:');
    } finally {
      await sb.cleanup();
    }
  });
});

describe('executePwshStream circuit breaker probe safety (F506)', () => {
  it('does not leak halfOpenProbeInFlight on pre-aborted command or blocked kill command', async () => {
    _resetProcessRegistry();
    const registry = getProcessRegistry();
    // `breaker` is private on ProcessRegistryImpl; reach its internals via a typed cast.
    const breaker = (
      registry as unknown as {
        breaker: {
          setEnabled(enabled: boolean): void;
          state: string;
          halfOpenProbeInFlight: boolean;
        };
      }
    ).breaker;
    breaker.setEnabled(true);

    try {
      breaker.state = 'half-open';
      breaker.halfOpenProbeInFlight = false;

      const abortCtrl = new AbortController();
      abortCtrl.abort();
      const ctx: any = {
        session: { id: 'test-f506-pwsh' },
        projectRoot: process.cwd(),
        workingDir: process.cwd(),
        signal: abortCtrl.signal,
      };

      const gen = executePwshStream({ command: 'Write-Output hello' }, ctx, {
        signal: abortCtrl.signal,
      });
      const res = await gen.next();
      expect(res.value?.output.exit_code).toBe(124);
      expect(breaker.halfOpenProbeInFlight).toBe(false);

      let blocked = false;
      try {
        const killCtx: any = {
          session: { id: 'test-f506-pwsh-kill' },
          projectRoot: process.cwd(),
          workingDir: process.cwd(),
          signal: new AbortController().signal,
        };
        const killGen = executePwshStream({ command: `Stop-Process -Id ${process.pid}` }, killCtx, {
          signal: killCtx.signal,
        });
        await killGen.next();
      } catch (err: any) {
        if (
          err.message.includes('targets a protected WrongStack process') ||
          err.message.includes('blocked')
        ) {
          blocked = true;
        }
      }
      expect(blocked).toBe(true);
      expect(breaker.halfOpenProbeInFlight).toBe(false);
    } finally {
      _resetProcessRegistry();
    }
  });
});
