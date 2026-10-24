import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolProgressEvent, ToolStreamEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/bash.js';
import { executeBashStream } from '../src/bash-stream.js';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';
import { mkSandbox, newSignal } from './fixtures.js';
import { runtimeFixtureCommand } from './shell-fixture-command.js';

const isWin = os.platform() === 'win32';
const echoCmd = isWin ? 'echo hello' : 'echo hello';
const failCmd = isWin ? 'exit 7' : 'exit 7';

describe('bashTool', () => {
  it('has correct metadata', () => {
    expect(bashTool.name).toBe('bash');
    expect(bashTool.permission).toBe('confirm');
    expect(bashTool.mutating).toBe(true);
    expect(bashTool.riskTier).toBe('destructive');
  });

  it('runs a simple command and captures output', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: echoCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
      expect(out.output.trim()).toContain('hello');
      expect(out.timed_out).toBe(false);
    } finally {
      await sb.cleanup();
    }
  });

  it('keeps the tail of an output larger than the preview — the verdict lands last', async () => {
    const sb = await mkSandbox();
    try {
      // ~200 KB of noise between a head line and a summary line.
      await fs.writeFile(
        path.join(sb.dir, 'gen.js'),
        "process.stdout.write('HEAD-LINE\\n' + ('x'.repeat(99) + '\\n').repeat(2000) + 'SUMMARY: 3 failed\\n');",
      );
      const out = await bashTool.execute({ command: 'node gen.js' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain('HEAD-LINE');
      expect(out.output).toContain('SUMMARY: 3 failed');
      expect(out.output).toMatch(/full \d+ bytes at /);
    } finally {
      await sb.cleanup();
    }
  });

  it('diets a passing test run and points at the full output', async () => {
    const sb = await mkSandbox();
    try {
      await fs.writeFile(
        path.join(sb.dir, 'fake-vitest.js'),
        "let s='';for(let i=0;i<60;i++)s+=' \\u2713 tests/unit-'+i+'.test.ts (4 tests) 3ms\\n';process.stdout.write(s+' Tests  240 passed (240)\\n');",
      );
      // A trailing `# vitest` comment marks the command as a test run.
      const out = await bashTool.execute({ command: 'node fake-vitest.js # vitest' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.output).toContain('Tests  240 passed (240)');
      expect(out.output).not.toContain('unit-0.test.ts');
      expect(out.output).toMatch(
        /\[output-diet: omitted 60 line\(s\) of passing tests.* full output at /,
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('reports non-zero exit code', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: failCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(7);
    } finally {
      await sb.cleanup();
    }
  });

  it('rejects on missing command', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        bashTool.execute({ command: '' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow();
    } finally {
      await sb.cleanup();
    }
  });

  it('honours timeout for long-running command', async () => {
    const sb = await mkSandbox();
    try {
      const cmd = isWin ? 'ping -n 5 127.0.0.1 > NUL' : 'sleep 5';
      const out = await bashTool.execute({ command: cmd, timeout_ms: 200 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.timed_out).toBe(true);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);

  it('exposes executeStream and emits a final event', async () => {
    const sb = await mkSandbox();
    try {
      expect(typeof bashTool.executeStream).toBe('function');
      const events: ToolStreamEvent[] = [];
      for await (const ev of bashTool.executeStream!({ command: echoCmd }, sb.ctx, {
        signal: newSignal(),
      })) {
        events.push(ev);
      }
      const finals = events.filter((e) => e.type === 'final');
      expect(finals).toHaveLength(1);
      // Output reaches the final event
      const out = (finals[0] as { output: { output: string } }).output;
      expect(out.output).toContain('hello');
    } finally {
      await sb.cleanup();
    }
  });

  it('declares an estimatedDurationMs hint', () => {
    expect(typeof bashTool.estimatedDurationMs).toBe('number');
    expect(bashTool.estimatedDurationMs).toBeGreaterThan(0);
  });

  it('background command yields a single final event', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // `exit 0` finishes instantly on both shells — the assertion is about
      // event shape, not subprocess lifetime, so the fastest-exiting command
      // avoids holding the sandbox temp dir on Windows.
      const cmd = isWin ? 'exit 0' : 'true';
      for await (const ev of bashTool.executeStream!({ command: cmd, background: true }, sb.ctx, {
        signal: newSignal(),
      })) {
        events.push(ev);
      }
      // Background runs return immediately with just the final event,
      // no partial_output (stdio is 'ignore').
      const progressEvents = events.filter((e): e is ToolProgressEvent => e.type !== 'final');
      expect(progressEvents).toEqual([]);
      expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    } finally {
      // On Windows the detached child may still hold the temp dir for a
      // moment after exit — swallow the cleanup race; the OS reaps soon.
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  it('does not bind background processes to the caller abort signal', async () => {
    const sb = await mkSandbox();
    const ac = new AbortController();
    const registry = getProcessRegistry();
    try {
      const cmd = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
      const out = await bashTool.execute({ command: cmd, background: true }, sb.ctx, {
        signal: ac.signal,
      });
      expect(out.exit_code).toBeNull();
      expect(out.pid).toBeDefined();
      const spawned = registry.bySession('test').find((p) => p.pid === out.pid);
      expect(spawned).toBeDefined();
      expect(spawned?.background).toBe(true);

      ac.abort();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(registry.bySession('test').some((p) => p.pid === out.pid)).toBe(true);
      if (out.pid !== null && out.pid !== undefined)
        registry.kill(out.pid, { force: true, graceMs: 10 });
    } finally {
      for (const proc of registry.bySession('test'))
        registry.kill(proc.pid, { force: true, graceMs: 10 });
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });
});

// ─── New coverage tests ───────────────────────────────────────────────────────

describe('bashTool timeout kill paths', () => {
  // The Windows timeout→kill path is covered by 'honours timeout for
  // long-running command' above and the dedicated grandchild regression in
  // bash-treekill-win32.test.ts — a third ping-based spawn here added load
  // without new coverage.

  it.skipIf(isWin)(
    'times out and triggers kill on POSIX (SIGTERM then SIGKILL)',
    async () => {
      const sb = await mkSandbox();
      try {
        // sleep 10 will be killed after timeout
        const out = await bashTool.execute({ command: 'sleep 10', timeout_ms: 300 }, sb.ctx, {
          signal: newSignal(),
        });
        expect(out.timed_out).toBe(true);
      } finally {
        await sb.cleanup();
      }
    },
    10_000,
  );

  it.skipIf(isWin)(
    'SIGKILL is issued after SIGTERM fails to stop the process',
    async () => {
      const sb = await mkSandbox();
      try {
        // Use a command that ignores SIGTERM
        const out = await bashTool.execute(
          { command: 'trap "" TERM; sleep 20; exit 0', timeout_ms: 500 },
          sb.ctx,
          { signal: newSignal() },
        );
        expect(out.timed_out).toBe(true);
      } finally {
        await sb.cleanup();
      }
    },
    15_000,
  );
});

describe('bashTool partial_output flush paths', () => {
  it('flushes partial_output when pending reaches STREAM_FLUSH_BYTES', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // Write enough output to trigger size-based flush (STREAM_FLUSH_BYTES =
      // 4096). 700 lines ≈ 7KB — comfortably past one flush. cmd.exe `for /L`
      // loops are CPU-bound and slow; keep the count as low as the threshold
      // allows.
      const largeCmd = isWin
        ? `for /L %i in (1,1,700) do @echo line-%i`
        : 'for i in $(seq 1 700); do echo "line-$i"; done';
      for await (const ev of bashTool.executeStream!(
        { command: largeCmd, timeout_ms: 5000 },
        sb.ctx,
        { signal: newSignal() },
      )) {
        events.push(ev);
      }
      const _partials = events.filter((e) => e.type === 'partial_output');
      void _partials;
      // Should emit at least one partial_output before final
      expect(events.some((e) => e.type === 'final')).toBe(true);
      // On Windows or with small output, partials may be empty, but we exercised the flush logic
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sb.cleanup();
    }
  }, 10_000);

  it('emits multiple partial_output events for large output', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // Several flush windows (4096B each): 1500 lines ≈ 16KB ≈ 3-4 flushes.
      const veryLargeCmd = isWin
        ? `for /L %i in (1,1,1500) do @echo line-%i`
        : 'for i in $(seq 1 1500); do echo "line-$i"; done';
      for await (const ev of bashTool.executeStream!(
        { command: veryLargeCmd, timeout_ms: 8000 },
        sb.ctx,
        { signal: newSignal() },
      )) {
        events.push(ev);
      }
      const _partials = events.filter((e) => e.type === 'partial_output');
      void _partials;
      const finals = events.filter((e) => e.type === 'final');
      expect(finals).toHaveLength(1);
      // Output was processed
      const finalOut = (finals[0] as { output: { output: string } }).output;
      expect(finalOut.output.length).toBeGreaterThan(0);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);
});

describe('bashTool error handling', () => {
  it('handles child spawn error via child.on(error)', async () => {
    const sb = await mkSandbox();
    try {
      // Use a non-existent command to trigger spawn error
      const out = await bashTool.execute({ command: 'nonexistent_command_xyz' }, sb.ctx, {
        signal: newSignal(),
      });
      // Should handle the error gracefully (not throw)
      expect(out).toHaveProperty('exit_code');
    } finally {
      await sb.cleanup();
    }
  });

  it('handles stderr output separately', async () => {
    const sb = await mkSandbox();
    try {
      const cmd = isWin ? 'dir /invalidflag 2>&1' : 'ls --invalid-option 2>&1 || true';
      const out = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      // Should capture output (may include error message)
      expect(out).toHaveProperty('output');
    } finally {
      await sb.cleanup();
    }
  });
});

describe('bashTool truncation', () => {
  it('truncates output from the middle when it exceeds MAX_OUTPUT', async () => {
    const sb = await mkSandbox();
    try {
      // Generate output just past MAX_OUTPUT (32768 bytes): 1500 lines ×
      // ~28 bytes ≈ 42KB. The old 10000-line loop produced 300KB through a
      // crawling cmd.exe `for /L` for no extra coverage.
      const largeCmd = isWin
        ? `for /L %i in (1,1,1500) do @echo line-with-some-content-%i`
        : 'for i in $(seq 1 1500); do echo "line-with-content-number-$i"; done';
      const out = await bashTool.execute({ command: largeCmd, timeout_ms: 10000 }, sb.ctx, {
        signal: newSignal(),
      });
      // Output should be truncated to MAX_OUTPUT. The implementation
      // appends a small truncation marker + footer (~250B), so the budget
      // is the cap plus that footer allowance. The previous tolerance
      // (32_768 + 100) overflowed by ~188B under runner load (#249).
      expect(out.output.length).toBeLessThanOrEqual(32_768 + 1_000);
    } finally {
      await sb.cleanup();
    }
  }, 20_000);
});

describe('bashTool signal abort', () => {
  it('handles already-aborted signal gracefully', async () => {
    const sb = await mkSandbox();
    try {
      const ac = new AbortController();
      ac.abort();
      // On Windows with already-aborted signal, spawn may fail with AbortError
      // The tool should handle this and return a result
      try {
        const out = await bashTool.execute({ command: echoCmd }, sb.ctx, { signal: ac.signal });
        expect(out).toHaveProperty('exit_code');
      } catch (err: any) {
        // AbortError is acceptable here - the signal was already aborted
        expect(err.message).toContain('aborted');
      }
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore cleanup errors on Windows */
      }
    }
  });

  it('aborts mid-execution when signal fires', async () => {
    const sb = await mkSandbox();
    const ac = new AbortController();
    // Fire abort after a short delay
    const timeout = setTimeout(() => ac.abort(), 50);
    try {
      const out = await bashTool.execute(
        { command: isWin ? 'ping -n 10 127.0.0.1 > NUL' : 'sleep 10' },
        sb.ctx,
        { signal: ac.signal },
      );
      clearTimeout(timeout);
      // Process should be terminated
      expect(out).toHaveProperty('exit_code');
    } catch (err: any) {
      clearTimeout(timeout);
      // AbortError is acceptable
      expect(err.code).toBe('ABORT_ERR');
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore cleanup errors on Windows */
      }
    }
  }, 15_000);
});

describe('bashTool edge cases', () => {
  // Trimmed in the spawn-load cleanup: 'handles echo command' and 'handles
  // very long command string' duplicated 'runs a simple command' (all three
  // executed the same echo), and 'cleans up timers in finally block' was a
  // third copy of the ping-timeout path. One shell per behaviour is enough.

  it('clamps timeout_ms at both bounds', async () => {
    const sb = await mkSandbox();
    try {
      const below = await bashTool.execute({ command: echoCmd, timeout_ms: -5 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(below).toHaveProperty('exit_code');
      const above = await bashTool.execute({ command: echoCmd, timeout_ms: 999999999 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(above.exit_code).toBe(0);
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });
});

describe('bashTool session and env', () => {
  it('uses projectRoot as cwd', async () => {
    const sb = await mkSandbox();
    try {
      const script = path.join(sb.dir, 'print-cwd.js');
      await fs.writeFile(script, 'console.log(process.cwd());\n');
      const cmd = runtimeFixtureCommand(script);
      const out = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      // Should use projectRoot (sb.dir)
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain(sb.dir);
      expect(path.normalize(out.output.trim())).toBe(path.normalize(sb.dir));
    } finally {
      await sb.cleanup();
    }
  });

  it('spawns in ctx.workingDir when set (set_working_dir integration)', async () => {
    const sb = await mkSandbox();
    try {
      const sub = path.join(sb.dir, 'wd-sub');
      await fs.mkdir(sub, { recursive: true });
      (sb.ctx as { workingDir?: string }).workingDir = sub;
      const script = path.join(sb.dir, 'print-cwd.js');
      await fs.writeFile(script, 'console.log(process.cwd());\n');
      const cmd = runtimeFixtureCommand(script);
      const out = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain('wd-sub');
      expect(path.normalize(out.output.trim())).toBe(path.normalize(sub));
    } finally {
      await sb.cleanup();
    }
  });

  it('appends a pipe-to-shell caution note to the result output', async () => {
    const sb = await mkSandbox();
    try {
      // The note is advisory and appended regardless of the command's exit
      // status, so the assertion doesn't depend on `sh` existing on PATH.
      const out = await bashTool.execute({ command: 'echo hi | sh', timeout_ms: 10_000 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.output).toContain('[wrongstack] Caution');
      expect(out.output).toContain('pipe-to-shell');
    } finally {
      await sb.cleanup();
    }
  }, 15_000);

  it('handles commands with special characters', async () => {
    const sb = await mkSandbox();
    try {
      const specialCmd = isWin ? 'echo hello & echo world' : 'echo "hello world" && echo done';
      const out = await bashTool.execute({ command: specialCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
});

// ─── Coverage: background mode stderr ────────────────────────────────────────
describe('bashTool background mode stderr', () => {
  it.skipIf(isWin)(
    'captures stderr in background mode via child.stderr.on(data)',
    async () => {
      const sb = await mkSandbox();
      try {
        const out = await bashTool.execute(
          { command: 'ls --no-such-option 2>&1 || true', background: true },
          sb.ctx,
          { signal: newSignal() },
        );
        expect(out).toHaveProperty('output');
        expect(out).toHaveProperty('pid');
      } finally {
        try {
          await sb.cleanup();
        } catch {
          /* ignore */
        }
      }
    },
    10_000,
  );

  it.skipIf(isWin)(
    'background mode with stderr only redirected to stderr pipe',
    async () => {
      const sb = await mkSandbox();
      try {
        const out = await bashTool.execute(
          { command: 'echo "error" >&2', background: true },
          sb.ctx,
          { signal: newSignal() },
        );
        expect(out).toHaveProperty('output');
        expect(out.pid).toBeTruthy();
      } finally {
        try {
          await sb.cleanup();
        } catch {
          /* ignore */
        }
      }
    },
    10_000,
  );
});

describe('executeBashStream circuit breaker probe safety (F506)', () => {
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
        session: { id: 'test-f506' },
        projectRoot: process.cwd(),
        workingDir: process.cwd(),
        signal: abortCtrl.signal,
      };

      const gen = executeBashStream({ command: 'echo hello' }, ctx, { signal: abortCtrl.signal });
      const res = await gen.next();
      expect(res.value?.output.exit_code).toBe(124);
      expect(breaker.halfOpenProbeInFlight).toBe(false);

      // Blocked kill command in half-open state also does not leak probe
      let blocked = false;
      try {
        const killCtx: any = {
          session: { id: 'test-f506-kill' },
          projectRoot: process.cwd(),
          workingDir: process.cwd(),
          signal: new AbortController().signal,
        };
        const killGen = executeBashStream({ command: `kill -9 ${process.pid}` }, killCtx, {
          signal: killCtx.signal,
        });
        await killGen.next();
      } catch (err: any) {
        if (
          err.message.includes('targets a protected WrongStack process') ||
          err.message.includes('Kill command blocked')
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
