/**
 * Smoke test for the input-latency bench harness (bench/input-latency-harness).
 * Exercises the measurement helper on the clearly-labeled MinimalEcho
 * component and asserts sane finite numbers — NOT performance thresholds.
 * Keeps the fake-TTY capture + frame-attribution path from rotting.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { INPUT_LATENCY_SEQUENCE, parseInputLatencyArgs } from '../bench/input-latency.js';
import {
  delayMs,
  MinimalEcho,
  measureEchoRun,
  renderLatencyTty,
  summarizeLatencies,
} from '../bench/input-latency-harness.js';

describe('input-latency bench harness', () => {
  it('measures finite keystroke→frame latencies on a trivial echo component', async () => {
    const tty = renderLatencyTty(createElement(MinimalEcho), {
      columns: 60,
      rows: 20,
      maxFps: 30,
    });
    try {
      // Let the mount commit land before injecting keystrokes.
      await delayMs(90);
      const sequence = 'abcdefghij'.split('');
      const expectedTexts = sequence.map((_, index) => sequence.slice(0, index + 1).join(''));
      const result = await measureEchoRun(tty, {
        sequence,
        expectedTexts,
        intervalMs: 5,
        flushMs: 120,
      });
      expect(result.missing).toEqual([]);
      expect(result.latenciesMs).toHaveLength(sequence.length);
      for (const latency of result.latenciesMs) {
        expect(Number.isFinite(latency)).toBe(true);
        expect(latency).toBeGreaterThanOrEqual(0);
        // Smoke bound only: a hung renderer, not a perf assertion.
        expect(latency).toBeLessThan(5000);
      }
      expect(result.framesWritten).toBeGreaterThan(0);
      expect(tty.lastFrame()).toContain('abcdefghij');

      const summary = summarizeLatencies(result.latenciesMs);
      expect(summary.samples).toBe(sequence.length);
      expect(summary.minMs).toBeLessThanOrEqual(summary.p50Ms);
      expect(summary.p50Ms).toBeLessThanOrEqual(summary.p95Ms);
      expect(summary.p95Ms).toBeLessThanOrEqual(summary.maxMs);
      for (const value of [
        summary.minMs,
        summary.p50Ms,
        summary.p95Ms,
        summary.maxMs,
        summary.meanMs,
        summary.spreadMs,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    } finally {
      tty.unmount();
    }
  });

  it('rejects an empty sample set instead of reporting fake percentiles', () => {
    expect(() => summarizeLatencies([])).toThrow(/zero samples/);
  });

  it('parses bench defaults and overrides deterministically', () => {
    const { help, options } = parseInputLatencyArgs([]);
    expect(help).toBe(false);
    expect(options.widths).toEqual([72, 160]);
    expect(options.component).toBe('composer');
    expect(options.samples).toBeGreaterThan(0);
    expect(options.warmup).toBeGreaterThan(0);
    expect(options.maxFps).toBeGreaterThan(0);
    expect(INPUT_LATENCY_SEQUENCE).toMatch(/^[a-z0-9]+$/);

    const overrides = parseInputLatencyArgs([
      '--widths',
      '40,100',
      '--samples',
      '8',
      '--warmup',
      '0',
      '--run-length',
      '4',
      '--interval-ms',
      '0',
      '--max-fps',
      '10',
      '--component',
      'echo',
    ]);
    expect(overrides.options.widths).toEqual([40, 100]);
    expect(overrides.options.samples).toBe(8);
    expect(overrides.options.warmup).toBe(0);
    expect(overrides.options.runLength).toBe(4);
    expect(overrides.options.intervalMs).toBe(0);
    expect(overrides.options.maxFps).toBe(10);
    expect(overrides.options.component).toBe('echo');
    expect(() => parseInputLatencyArgs(['--component', 'app'])).toThrow(/composer or echo/);
    expect(() => parseInputLatencyArgs(['--samples', '0'])).toThrow(/positive integer/);
  });
});
