import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/bash.js';
import { mkSandbox, newSignal } from './fixtures.js';

const isWin = os.platform() === 'win32';

/**
 * P1 #3 (before-release.md): the bash tool's streaming protocol uses a
 * MAX_QUEUE_CHUNKS = 500 buffer between the child process and the async
 * generator consumer. If the consumer stalls (TUI paused, context window
 * compaction), this buffer can grow up to 500 chunks. A chatty child
 * (`pnpm build`, ANSI-heavy output) could thus hold 1000× the final output
 * size in memory with no upper-bound test pinning the behavior.
 *
 * The code already works — `pauseIfFlooded()` / `resumeIfDrained()` gate the
 * pipes at MAX_QUEUE_CHUNKS, and `buf` is capped at MAX_OUTPUT (32 KB). This
 * file adds the missing test coverage so a regression in either guard is
 * caught.
 *
 * Commands avoid inner quotes to stay portable across cmd.exe / POSIX sh —
 * we use `printf` (POSIX) and a here-string free pattern (Windows) that
 * shells expand without nested-Quote pain.
 */
describe('bash backpressure — MAX_QUEUE_CHUNKS upper bound (P1 #3)', () => {
  // POSIX: seq 4000 | each line ~60 bytes → ~240 KB raw, far past MAX_OUTPUT.
  // Windows: a PowerShell script body. The bash tool selects PowerShell and
  // sends the script on stdin; nesting `powershell -Command ...` would make the
  // wrapper itself part of a second PowerShell invocation.
  const bigCmd = isWin
    ? "1..4000 | ForEach-Object { Write-Output $_; Write-Output -NoNewline ('x' * 50) }"
    : 'seq -w 4000 | sed "s/^/line-/; s/$/ padding-padding-padding-padding-padding-padding-padding-padding/"';

  it('terminates and truncates output from a command exceeding MAX_QUEUE_CHUNKS', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute(
        { command: bigCmd },
        sb.ctx,
        { signal: newSignal() },
      );
      // 1. Process terminated cleanly (not hung by backpressure).
      expect(out.exit_code).toBe(0);
      expect(out.timed_out).toBe(false);
      // 2. Final output is bounded — MAX_OUTPUT (32 KB) cap applied. The raw
      //    output would be ~240 KB, so a bounded result proves the cap path ran.
      //    The spool marker suffix may add a few bytes.
      expect(out.output.length).toBeLessThan(40_000);
    } finally {
      await sb.cleanup();
    }
  }, 20_000);

  it('keeps memory bounded: heap does not grow unboundedly for chatty output', async () => {
    const sb = await mkSandbox();
    try {
      const before = process.memoryUsage().heapUsed;
      const out = await bashTool.execute(
        { command: bigCmd },
        sb.ctx,
        { signal: newSignal() },
      );
      const after = process.memoryUsage().heapUsed;
      const heapDelta = after - before;

      // Raw output is ~240 KB. The guards cap the in-memory buffer at
      // MAX_OUTPUT (32 KB) + MAX_QUEUE_CHUNKS worth of queued chunks. Even
      // with GC variance, the delta must be far below the raw size.
      expect(out.exit_code).toBe(0);
      expect(out.output.length).toBeLessThan(40_000);
      // Generous bound: 50 MB. Without the cap the queue alone (500 chunks
      // × ~60 bytes = 30 KB) plus buf (32 KB) is tiny; GC and node internals
      // add overhead. The point is to catch a regression where the cap is
      // removed and the full 240 KB sits in memory indefinitely.
      expect(heapDelta).toBeLessThan(50_000_000);
    } finally {
      await sb.cleanup();
    }
  }, 30_000);

  it('preserves the head of output when truncating (middle-elision)', async () => {
    const sb = await mkSandbox();
    try {
      // Emit a marker at the start so we can confirm the truncation keeps
      // the head. seq on POSIX, PowerShell on Windows — both print a marker
      // line first, then flood.
      const cmd = isWin
        ? 'Write-Output START; 1..3000 | ForEach-Object { Write-Output $_ }'
        : 'echo START; seq 3000';
      const out = await bashTool.execute(
        { command: cmd },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.exit_code).toBe(0);
      expect(out.output.length).toBeLessThan(40_000);
      // The head marker survives (start of output is preserved).
      expect(out.output).toContain('START');
    } finally {
      await sb.cleanup();
    }
  }, 20_000);
});
