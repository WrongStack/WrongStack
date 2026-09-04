import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gnuTimeMaxRssExtractor,
  hyperfineMeanExtractor,
  jsonPathExtractor,
  type PerfRunOutput,
  regexExtractor,
  resolveExtractor,
} from '../../src/performance/perf-extractors.js';
import { describeMachine, measure, runOnce } from '../../src/performance/perf-runner.js';
import {
  detectPerfStacks,
  GENERIC_STACK,
  renderStackGuidance,
} from '../../src/performance/perf-stack.js';

function output(partial: Partial<PerfRunOutput>): PerfRunOutput {
  return { stdout: '', stderr: '', wallMs: 10, exitCode: 0, ...partial };
}

describe('metric extractors', () => {
  it('pulls a capture group and applies a scale', () => {
    const extract = regexExtractor(/took ([\d.]+)s/, { scale: 1000 });
    expect(extract(output({ stdout: 'took 1.25s\n' }))).toBe(1250);
  });

  it('falls back to stderr, because harnesses disagree about which stream is results', () => {
    expect(regexExtractor(/ops=(\d+)/)(output({ stderr: 'ops=42' }))).toBe(42);
  });

  it('strips digit separators', () => {
    expect(regexExtractor(/rss=([\d,]+)/)(output({ stdout: 'rss=1,234,567' }))).toBe(1234567);
  });

  it('does not carry lastIndex between runs for a /g pattern', () => {
    // A sticky or global caller-supplied regex would match the first run and
    // then silently return undefined for the rest, turning a measurement into
    // a single sample.
    const extract = regexExtractor(/ms=(\d+)/g);
    expect(extract(output({ stdout: 'ms=10' }))).toBe(10);
    expect(extract(output({ stdout: 'ms=11' }))).toBe(11);
  });

  it('returns undefined rather than guessing when the metric is absent', () => {
    expect(regexExtractor(/ms=(\d+)/)(output({ stdout: 'nothing here' }))).toBeUndefined();
  });

  it('reads a dotted path out of whole-stdout JSON', () => {
    const extract = jsonPathExtractor('benchmarks.parse.medianMs');
    expect(extract(output({ stdout: '{"benchmarks":{"parse":{"medianMs":12.5}}}' }))).toBe(12.5);
  });

  it('reads the last JSON line when progress logs come first', () => {
    const stdout = ['running…', 'still running', '{"total":{"ops":900}}'].join('\n');
    expect(jsonPathExtractor('total.ops')(output({ stdout }))).toBe(900);
  });

  it('indexes into arrays', () => {
    expect(jsonPathExtractor('rows.1.ms')(output({ stdout: '{"rows":[{"ms":1},{"ms":2}]}' }))).toBe(
      2,
    );
  });

  it('returns undefined for a path that lands on a non-number', () => {
    expect(jsonPathExtractor('a.b')(output({ stdout: '{"a":{"b":"fast"}}' }))).toBeUndefined();
    expect(jsonPathExtractor('a.z')(output({ stdout: '{"a":{"b":1}}' }))).toBeUndefined();
  });

  it('converts GNU time max RSS from KB to bytes', () => {
    const stderr = '\tMaximum resident set size (kbytes): 2048\n';
    expect(gnuTimeMaxRssExtractor(output({ stderr }))).toBe(2048 * 1024);
  });

  it('reads hyperfine mean in both seconds and milliseconds', () => {
    expect(hyperfineMeanExtractor(output({ stdout: 'Time (mean ± σ):     1.500 s' }))).toBe(1500);
    expect(hyperfineMeanExtractor(output({ stdout: 'Time (mean ± σ):     42.0 ms' }))).toBe(42);
  });

  it('resolves extractor specs and rejects typos loudly', () => {
    expect(resolveExtractor('wall')(output({ wallMs: 7 }))).toBe(7);
    expect(resolveExtractor('re:count=(\\d+)')(output({ stdout: 'count=9' }))).toBe(9);
    expect(resolveExtractor('json:a')(output({ stdout: '{"a":3}' }))).toBe(3);
    // Falling back to wall time here would quietly measure the wrong thing.
    expect(() => resolveExtractor('wal')).toThrow(/unknown metric extractor/);
  });
});

describe('runOnce', () => {
  it('captures stdout and the exit code', async () => {
    const result = await runOnce({
      command: 'node -e "console.log(\'hello-perf\')"',
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-perf');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit instead of throwing', async () => {
    const result = await runOnce({ command: 'node -e "process.exit(3)"', cwd: process.cwd() });
    expect(result.exitCode).toBe(3);
  });

  it('kills a hung command and marks the run as timed out', { timeout: 60_000 }, async () => {
    const result = await runOnce({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      cwd: process.cwd(),
      timeoutMs: 750,
    });
    expect(result.timedOut).toBe(true);
  });
});

describe('measure', () => {
  it('produces stats from repeat runs', async () => {
    const measurement = await measure({
      command: 'node -e "console.log(\'value=100\')"',
      cwd: process.cwd(),
      metric: 'wall-ms',
      runs: 3,
      warmup: 0,
      extract: regexExtractor(/value=(\d+)/),
    });
    expect(measurement.samples).toEqual([100, 100, 100]);
    expect(measurement.median).toBe(100);
    expect(measurement.spread).toBe(0);
    expect(measurement.command).toContain('value=100');
  }, 30_000);

  it('refuses to report a measurement built from fewer than three usable runs', async () => {
    // Two samples have no spread to speak of; a verdict against them would be
    // a coin flip wearing a percentage sign.
    await expect(
      measure({
        command: 'node -e "process.exit(1)"',
        cwd: process.cwd(),
        metric: 'wall-ms',
        runs: 3,
        warmup: 0,
      }),
    ).rejects.toThrow(/only 0 usable run/);
  }, 30_000);

  it('discards a run whose extractor found nothing and says so', async () => {
    await expect(
      measure({
        command: 'node -e "console.log(\'no metric here\')"',
        cwd: process.cwd(),
        metric: 'wall-ms',
        runs: 3,
        warmup: 0,
        extract: regexExtractor(/value=(\d+)/),
      }),
    ).rejects.toThrow(/produced no metric value/);
  }, 30_000);
});

describe('describeMachine', () => {
  it('names the CPU, memory, platform, and runtime', () => {
    const description = describeMachine();
    expect(description).toContain('GB');
    expect(description).toContain(process.platform);
    expect(description).toContain(process.versions.node);
  });
});

describe('detectPerfStacks', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-perfstack-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('identifies a stack by its marker file', async () => {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    const [stack] = await detectPerfStacks(dir);
    expect(stack?.id).toBe('go');
    expect(stack?.detectedBy).toBe('go.mod');
    expect(stack?.benchmark.join(' ')).toContain('benchstat');
  });

  it('reports every stack in a polyglot repo, not just the first', async () => {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    await fs.writeFile(path.join(dir, 'package.json'), '{}\n');
    const ids = (await detectPerfStacks(dir)).map((s) => s.id);
    expect(ids).toContain('go');
    expect(ids).toContain('node');
  });

  it('matches .NET projects by extension', async () => {
    await fs.writeFile(path.join(dir, 'App.csproj'), '<Project />\n');
    expect((await detectPerfStacks(dir))[0]?.id).toBe('dotnet');
  });

  it('falls back to the generic profile for an unrecognised or unreadable dir', async () => {
    expect(await detectPerfStacks(dir)).toEqual([GENERIC_STACK]);
    expect(await detectPerfStacks(path.join(dir, 'does-not-exist'))).toEqual([GENERIC_STACK]);
  });

  it('renders guidance the prompt can carry', async () => {
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\n');
    const text = renderStackGuidance(await detectPerfStacks(dir));
    expect(text).toContain('### Rust');
    expect(text).toContain('cargo flamegraph');
    expect(text).toContain('Profiling commands for this repository');
  });
});
