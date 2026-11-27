#!/usr/bin/env bun
/**
 * On-demand keystroke→paint latency benchmark for the TUI composer.
 *
 * Default workload: the REAL composer `Input` (src/components/input.tsx)
 * mounted bare (no app shell, no history) with a minimal draft host that
 * appends printable keystrokes — the same value/cursor/onKey contract the
 * app's key router drives. `--component echo` swaps in a clearly-labeled
 * minimal echo component for harness debugging only; the JSON report names
 * which component ran.
 *
 * What is measured: elapsed ms from each `stdin.write(key)` until the first
 * captured Ink stdout frame containing the echoed draft, in-process, with
 * Ink's production `maxFps` render throttle active (non-debug interactive
 * mode). NOT real terminal paint, PTY transport, or OS scheduling.
 *
 * Run: bun bench/input-latency.tsx [--widths 72,160] [--samples 96] ...
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ReactElement, type RefObject, useCallback, useEffect, useState } from 'react';
import { Input, type KeyEvent } from '../src/components/input.js';
import { tuiRenderMaxFps } from '../src/run-tui-mount.js';
import {
  delayMs,
  type LatencySummary,
  MinimalEcho,
  measureEchoRun,
  renderLatencyTty,
  summarizeLatencies,
} from './input-latency-harness.js';

/** Deterministic printable workload; cycles so every run replays the same keys. */
export const INPUT_LATENCY_SEQUENCE = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface InputLatencyOptions {
  widths: number[];
  rows: number;
  samples: number;
  warmup: number;
  runLength: number;
  intervalMs: number;
  maxFps: number;
  component: 'composer' | 'echo';
  output: string | null;
}

function usage(): string {
  return `Usage: bun bench/input-latency.tsx [options]

Options:
  --widths <list>      Comma-separated terminal widths (default: 72,160)
  --rows <n>           Fake terminal height (default: 30)
  --samples <n>        Measured keystrokes per width (default: 96)
  --warmup <n>         Discarded warm-up keystrokes per width (default: 32)
  --run-length <n>     Keystrokes per draft cycle before reset (default: 32)
  --interval-ms <n>    Fixed pacing between keystrokes (default: 10)
  --max-fps <n>        Ink render throttle (default: production tuiRenderMaxFps())
  --component <name>   composer (real Input, default) | echo (minimal fallback)
  --output <path>      Also write the JSON report to this path
  --help               Show this help
`;
}

function positiveInteger(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw ?? '<missing>'}`);
  }
  return value;
}

export function parseInputLatencyArgs(argv: string[]): {
  help: boolean;
  options: InputLatencyOptions;
} {
  const options: InputLatencyOptions = {
    widths: [72, 160],
    rows: 30,
    samples: 96,
    warmup: 32,
    runLength: 32,
    intervalMs: 10,
    maxFps: tuiRenderMaxFps(),
    component: 'composer',
    output: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === '--help') return { help: true, options };
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value after ${arg}`);
    switch (arg) {
      case '--widths': {
        options.widths = value.split(',').map((part) => positiveInteger(part.trim(), 'width'));
        if (options.widths.length === 0) throw new Error('--widths must not be empty');
        break;
      }
      case '--rows':
        options.rows = positiveInteger(value, 'rows');
        break;
      case '--samples':
        options.samples = positiveInteger(value, 'samples');
        break;
      case '--warmup': {
        const warmup = Number(value);
        if (!Number.isSafeInteger(warmup) || warmup < 0) {
          throw new Error(`warmup must be a non-negative integer, got ${value}`);
        }
        options.warmup = warmup;
        break;
      }
      case '--run-length':
        options.runLength = positiveInteger(value, 'run-length');
        break;
      case '--interval-ms': {
        const interval = Number(value);
        if (!Number.isFinite(interval) || interval < 0) {
          throw new Error(`interval-ms must be a non-negative number, got ${value}`);
        }
        options.intervalMs = interval;
        break;
      }
      case '--max-fps':
        options.maxFps = positiveInteger(value, 'max-fps');
        break;
      case '--component':
        if (value !== 'composer' && value !== 'echo') {
          throw new Error(`--component must be composer or echo, got ${value}`);
        }
        options.component = value;
        break;
      case '--output':
        options.output = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { help: false, options };
}

/**
 * Minimal draft host around the REAL composer Input. Mirrors the app's
 * contract (value/cursor/onKey) without the app shell: printable keys append
 * at the cursor, editing keys trim, everything else is ignored. Idle status,
 * no workingClock — the composer subscribes to no timers in this state.
 */
function ComposerEchoHost({
  resetRef,
}: {
  resetRef: RefObject<(() => void) | null>;
}): ReactElement {
  const [value, setValue] = useState('');
  useEffect(() => {
    resetRef.current = () => setValue('');
    return () => {
      resetRef.current = null;
    };
  }, [resetRef]);
  const onKey = useCallback((input: string, key: KeyEvent) => {
    if (key.ctrl || key.meta || key.return || key.escape || key.tab) return;
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (input) setValue((current) => current + input);
  }, []);
  return (
    <Input value={value} cursor={value.length} onKey={onKey} prompt="" title="" footerHint="" />
  );
}

/** Wait long enough for the throttle's trailing edge plus margin. */
function flushMsFor(maxFps: number): number {
  return 2 * Math.max(1, Math.ceil(1000 / maxFps)) + 20;
}

function buildRun(
  runLength: number,
  keyOffset: number,
): { sequence: string[]; expectedTexts: string[] } {
  const sequence: string[] = [];
  const expectedTexts: string[] = [];
  let draft = '';
  for (let i = 0; i < runLength; i++) {
    const char = INPUT_LATENCY_SEQUENCE[(keyOffset + i) % INPUT_LATENCY_SEQUENCE.length] as string;
    sequence.push(char);
    draft += char;
    expectedTexts.push(draft);
  }
  return { sequence, expectedTexts };
}

interface WidthResult {
  columns: number;
  rows: number;
  component: 'real-composer-input' | 'minimal-echo';
  summary: LatencySummary;
  latenciesMs: number[];
}

async function runWidth(options: InputLatencyOptions, width: number): Promise<WidthResult> {
  const resetRef: RefObject<(() => void) | null> = { current: null };
  const element =
    options.component === 'composer' ? (
      <ComposerEchoHost resetRef={resetRef} />
    ) : (
      <MinimalEcho resetRef={resetRef} />
    );
  const tty = renderLatencyTty(element, {
    columns: width,
    rows: options.rows,
    maxFps: options.maxFps,
  });
  const flushMs = flushMsFor(options.maxFps);
  const latencies: number[] = [];
  try {
    // Let the mount commit land and the throttle go quiescent before timing.
    await delayMs(flushMs);
    const totalRuns =
      Math.ceil(options.warmup / options.runLength) +
      Math.ceil(options.samples / options.runLength);
    const warmupRuns = Math.ceil(options.warmup / options.runLength);
    let keyOffset = 0;
    for (let run = 0; run < totalRuns; run++) {
      const { sequence, expectedTexts } = buildRun(options.runLength, keyOffset);
      keyOffset = (keyOffset + options.runLength) % INPUT_LATENCY_SEQUENCE.length;
      const result = await measureEchoRun(tty, {
        sequence,
        expectedTexts,
        intervalMs: options.intervalMs,
        flushMs,
      });
      if (result.missing.length > 0) {
        throw new Error(
          `width ${width}: echo never appeared for keystrokes ${result.missing.join(',')} — invalid run`,
        );
      }
      if (run >= warmupRuns) latencies.push(...result.latenciesMs);
      // Reset the draft outside the measured window, then go quiescent again
      // so every run starts from the same state.
      resetRef.current?.();
      await delayMs(flushMs);
    }
  } finally {
    tty.unmount();
  }
  const samples = latencies.slice(0, options.samples);
  return {
    columns: width,
    rows: options.rows,
    component: options.component === 'composer' ? 'real-composer-input' : 'minimal-echo',
    summary: summarizeLatencies(samples),
    latenciesMs: samples.map((value) => Math.round(value * 1000) / 1000),
  };
}

async function main(): Promise<void> {
  const { help, options } = parseInputLatencyArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(usage());
    return;
  }
  // Pin the portable glyph profile like vitest.config.ts does, so installed
  // Nerd Fonts cannot change frame text between machines.
  process.env['WRONGSTACK_TUI_ICON_STYLE'] ??= 'unicode';
  const widths: WidthResult[] = [];
  for (const width of options.widths) {
    widths.push(await runWidth(options, width));
  }
  const report = {
    schemaVersion: 1,
    benchmark: 'tui-input-latency',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    measures:
      'keystroke write -> first captured Ink frame containing the echoed draft (in-process; not terminal paint)',
    component: options.component === 'composer' ? 'real-composer-input' : 'minimal-echo',
    throttle: {
      maxFps: options.maxFps,
      renderThrottleMs: Math.max(1, Math.ceil(1000 / options.maxFps)),
      incrementalRendering: false,
      debug: false,
    },
    workload: {
      sequence: INPUT_LATENCY_SEQUENCE,
      runLength: options.runLength,
      intervalMs: options.intervalMs,
      samples: options.samples,
      warmup: options.warmup,
    },
    widths,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, json, 'utf8');
  }
  process.stdout.write(json);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
