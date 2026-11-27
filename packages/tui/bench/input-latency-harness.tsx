/**
 * Deterministic keystroke→frame-commit latency harness for the TUI composer.
 *
 * Modeled on tests/helpers/real-tty.tsx (fake TTY streams driving Ink's real
 * renderer), with two differences that matter for measurement:
 *
 * 1. Every stdout write is timestamped with `performance.now()` at capture,
 *    so latency is read from recorded frames instead of polled wall-clock.
 * 2. Ink runs in NON-debug interactive mode with the production `maxFps`
 *    throttle. `debug: true` (what real-tty uses) disables the throttle
 *    entirely (see ink/build/ink.js: `options.debug || isScreenReaderEnabled`
 *    → unthrottled), which would measure a render path production never uses.
 *    `interactive: true` is explicit so CI env detection cannot silently
 *    switch Ink to write-only-at-unmount mode. `incrementalRendering: false`
 *    makes every commit a whole-frame write, so echo detection is a plain
 *    substring check on the captured frame.
 *
 * This measures keystroke→Ink frame-commit IN-PROCESS. It does not measure
 * real terminal paint, OS scheduling, or PTY transport.
 */
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { render, Text, useInput } from 'ink';
import { type ReactElement, type RefObject, useEffect, useState } from 'react';

export interface LatencyFrame {
  /** performance.now() at the moment Ink wrote the frame. */
  at: number;
  /** Raw chunk Ink wrote (ANSI included). */
  text: string;
}

class TimestampedStdout extends EventEmitter {
  isTTY = true;
  frames: LatencyFrame[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write(chunk: string | Uint8Array): boolean {
    this.frames.push({
      at: performance.now(),
      text: typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    });
    return true;
  }
}

class FakeStdin extends EventEmitter {
  private chunks: string[] = [];
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
  ref(): void {}
  unref(): void {}
  write(input: string): void {
    this.chunks.push(input);
    this.emit('data', Buffer.from(input));
    this.emit('readable');
  }
}

export interface LatencyTty {
  stdout: TimestampedStdout;
  stdin: FakeStdin;
  /** Latest captured frame, ANSI stripped. */
  lastFrame(): string;
  unmount(): void;
}

/** Render into a timestamped fake TTY with the production render throttle. */
export function renderLatencyTty(
  element: ReactElement,
  {
    columns = 72,
    rows = 30,
    maxFps = 30,
  }: { columns?: number; rows?: number; maxFps?: number } = {},
): LatencyTty {
  const stdout = new TimestampedStdout(columns, rows);
  const stdin = new FakeStdin();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps,
    incrementalRendering: false,
  });
  return {
    stdout,
    stdin,
    lastFrame: () => {
      // Ink writes synchronized-update / cursor control escapes as separate
      // chunks; the latest *visible* frame is the last non-empty cleaned one.
      for (let i = stdout.frames.length - 1; i >= 0; i--) {
        const text = cleanFrame(stdout.frames[i]?.text ?? '');
        if (text.trim().length > 0) return text;
      }
      return '';
    },
    unmount: () => instance.unmount(),
  };
}

/** Strip ANSI colors/links/private-mode sequences (real-tty pattern + `?`). */
export function cleanFrame(frame: string): string {
  return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07]*?(?:\x07|\x1b\\)/g, '');
}

/** ANSI-stripped and whitespace-collapsed, for wrap-proof echo matching. */
function normalizeForMatch(text: string): string {
  return cleanFrame(text).replace(/\s+/g, '');
}

export const delayMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface EchoRunOptions {
  /** Printable keystrokes, injected one per `intervalMs`. */
  sequence: string[];
  /** Draft text expected on screen after each keystroke (cumulative). */
  expectedTexts: string[];
  /** Fixed pacing between keystroke writes (the workload, not a settle). */
  intervalMs: number;
  /** Post-run wait so the throttle's trailing edge flushes the last frame. */
  flushMs: number;
}

export interface EchoRunResult {
  /** Keystroke write → first frame containing the echoed draft, in ms. */
  latenciesMs: number[];
  /** Keystroke indices whose echo never appeared (invalid run if non-empty). */
  missing: number[];
  /** Frames captured during the run (includes ANSI-only control writes). */
  framesWritten: number;
}

/**
 * Inject a fixed keystroke sequence at a fixed cadence, then attribute each
 * keystroke to the first captured frame (timestamp ≥ write) whose text
 * contains the expected cumulative draft. Attribution is offline over the
 * timestamped frame log, so no polling or wall-clock waits sit inside the
 * measured interval.
 */
export async function measureEchoRun(
  tty: Pick<LatencyTty, 'stdin' | 'stdout'>,
  { sequence, expectedTexts, intervalMs, flushMs }: EchoRunOptions,
): Promise<EchoRunResult> {
  if (sequence.length !== expectedTexts.length) {
    throw new Error('sequence and expectedTexts must have the same length');
  }
  const startFrame = tty.stdout.frames.length;
  const writtenAt: number[] = [];
  for (let i = 0; i < sequence.length; i++) {
    const key = sequence[i] as string;
    writtenAt.push(performance.now());
    tty.stdin.write(key);
    if (i < sequence.length - 1) await delayMs(intervalMs);
  }
  await delayMs(flushMs);

  const frames = tty.stdout.frames.slice(startFrame).map((frame) => ({
    at: frame.at,
    text: normalizeForMatch(frame.text),
  }));
  const latenciesMs: number[] = [];
  const missing: number[] = [];
  let cursor = 0;
  for (let i = 0; i < sequence.length; i++) {
    const expected = normalizeForMatch(expectedTexts[i] as string);
    const since = writtenAt[i] as number;
    let found = -1;
    for (let f = cursor; f < frames.length; f++) {
      const frame = frames[f] as { at: number; text: string };
      if (frame.at >= since && frame.text.includes(expected)) {
        found = f;
        break;
      }
    }
    if (found === -1) {
      missing.push(i);
      continue;
    }
    // Drafts grow monotonically within a run, so the next keystroke's echo
    // cannot be in an earlier frame than this one.
    cursor = found;
    latenciesMs.push((frames[found] as { at: number }).at - since);
  }
  return { latenciesMs, missing, framesWritten: frames.length };
}

export interface LatencySummary {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  /** max − min: compare this against any apparent win before believing it. */
  spreadMs: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Nearest-rank percentiles over a copy; never mutates the samples. */
export function summarizeLatencies(samples: number[]): LatencySummary {
  if (samples.length === 0) throw new Error('cannot summarize zero samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  return {
    samples: samples.length,
    minMs: round3(min),
    p50Ms: round3(rank(0.5)),
    p95Ms: round3(rank(0.95)),
    maxMs: round3(max),
    meanMs: round3(mean),
    spreadMs: round3(max - min),
  };
}

/**
 * Clearly-labeled MINIMAL echo component (fallback / smoke-test workload).
 * It is NOT the composer: no rails, no wrapping, no raw-stdin parser. The
 * bench's default workload is the real `Input` (see input-latency.tsx).
 */
export function MinimalEcho({
  resetRef,
}: {
  resetRef?: RefObject<(() => void) | null> | undefined;
}): ReactElement {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (!resetRef) return;
    resetRef.current = () => setValue('');
    return () => {
      resetRef.current = null;
    };
  }, [resetRef]);
  useInput((input, key) => {
    if (key.ctrl || key.meta || key.return || key.escape || key.tab) return;
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (input) setValue((current) => current + input);
  });
  return <Text>{value}</Text>;
}
