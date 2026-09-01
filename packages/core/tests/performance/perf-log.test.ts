import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPerfAttempt,
  appendPerfRound,
  latestRound,
  parsePerfLog,
  type PerfRound,
  renderPerfLog,
  renderRound,
  summarizePerfLog,
} from '../../src/performance/perf-log.js';

const SAMPLE = `# PERF_LOG

Notes above the first round are preserved.

## 2026-09-01 — parser throughput
commit:   a1b2c3d
machine:  M2 Pro / 16GB / macOS 15.2 / go1.24
command:  go test -bench=BenchmarkParse -benchmem -count=5 ./internal/parser
baseline: 412ms median, 1.2GB allocs, 84k allocs/op

- [KEPT]     preallocate token slice with known capacity → 388ms, 61k allocs/op (-27% allocs)
- [REVERTED] replace map with sorted slice lookup        → 409ms, within noise
- [KEPT]     reuse scanner buffer across calls           → 301ms (-22% vs previous)

current:  301ms median, 340MB allocs, 58k allocs/op (-27% wall vs baseline)
failed hypotheses: map lookup was not the bottleneck; cost is in bufio growth.
`;

describe('parsePerfLog', () => {
  it('recovers the round, its fields, and every attempt', () => {
    const doc = parsePerfLog(SAMPLE);
    expect(doc.preamble).toContain('Notes above the first round are preserved.');
    expect(doc.rounds).toHaveLength(1);
    const round = doc.rounds[0];
    expect(round?.date).toBe('2026-09-01');
    expect(round?.title).toBe('parser throughput');
    expect(round?.commit).toBe('a1b2c3d');
    expect(round?.command).toContain('go test -bench=BenchmarkParse');
    expect(round?.baseline).toBe('412ms median, 1.2GB allocs, 84k allocs/op');
    expect(round?.current).toContain('301ms median');
    expect(round?.failedHypotheses).toMatch(/bufio growth/);
    expect(round?.attempts.map((a) => a.outcome)).toEqual(['KEPT', 'REVERTED', 'KEPT']);
    expect(round?.attempts[1]?.summary).toBe('replace map with sorted slice lookup');
    expect(round?.attempts[1]?.result).toBe('409ms, within noise');
  });

  it('round-trips through render without losing data', () => {
    const first = parsePerfLog(SAMPLE);
    const second = parsePerfLog(renderPerfLog(first));
    expect(second.rounds).toEqual(first.rounds);
  });

  it('accepts an ASCII arrow and an ASCII dash in the heading', () => {
    const doc = parsePerfLog(
      ['## 2026-09-02 - cold start', '', '- [KEPT] lazy config load -> 120ms (-40%)'].join('\n'),
    );
    expect(doc.rounds[0]?.title).toBe('cold start');
    expect(doc.rounds[0]?.attempts[0]?.result).toBe('120ms (-40%)');
  });

  it('ignores stray prose inside a round instead of rejecting the file', () => {
    const doc = parsePerfLog(
      ['## 2026-09-03 — x', 'a human note that is not a field', 'commit:   abc'].join('\n'),
    );
    expect(doc.rounds[0]?.commit).toBe('abc');
  });

  it('treats a field with no value as absent', () => {
    const doc = parsePerfLog(['## 2026-09-03 — x', 'commit:', 'machine:   dev-box'].join('\n'));
    expect(doc.rounds[0]?.commit).toBeUndefined();
    expect(doc.rounds[0]?.machine).toBe('dev-box');
  });

  it('returns an empty document for empty input', () => {
    expect(parsePerfLog('').rounds).toEqual([]);
  });
});

describe('renderRound', () => {
  it('aligns the result arrows so a round reads as a column', () => {
    const round: PerfRound = {
      date: '2026-09-01',
      title: 'x',
      attempts: [
        { outcome: 'KEPT', summary: 'short', result: 'a' },
        { outcome: 'REVERTED', summary: 'a much longer change summary', result: 'b' },
      ],
    };
    const lines = renderRound(round).split('\n');
    const arrowColumns = lines
      .filter((line) => line.includes('→'))
      .map((line) => line.indexOf('→'));
    expect(new Set(arrowColumns).size).toBe(1);
  });

  it('omits the arrow when there is no measured result', () => {
    const line = renderRound({
      date: '2026-09-01',
      title: 'x',
      attempts: [{ outcome: 'KEPT', summary: 'no number yet', result: '' }],
    });
    expect(line).toContain('- [KEPT] no number yet');
    expect(line).not.toContain('→');
  });
});

describe('PERF_LOG.md on disk', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-perflog-'));
    file = path.join(dir, 'PERF_LOG.md');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('seeds the header when the file does not exist yet', async () => {
    await appendPerfRound(file, {
      date: '2026-09-01',
      title: 'boot',
      baseline: '900ms median',
      attempts: [],
    });
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('# PERF_LOG');
    expect(text).toContain('## 2026-09-01 — boot');
  });

  it('merges a re-run of the same workload on the same day', async () => {
    await appendPerfRound(file, {
      date: '2026-09-01',
      title: 'boot',
      baseline: '900ms median',
      attempts: [{ outcome: 'KEPT', summary: 'lazy config', result: '700ms (-22%)' }],
    });
    // The second sitting must not fork a duplicate round, and must not
    // overwrite the original baseline — the distance from it is the point.
    const doc = await appendPerfRound(file, {
      date: '2026-09-01',
      title: 'boot',
      baseline: '700ms median',
      attempts: [{ outcome: 'REVERTED', summary: 'skip validation', result: 'within noise' }],
      current: '700ms median (-22% vs baseline)',
    });
    expect(doc.rounds).toHaveLength(1);
    expect(doc.rounds[0]?.baseline).toBe('900ms median');
    expect(doc.rounds[0]?.attempts).toHaveLength(2);
    expect(doc.rounds[0]?.current).toBe('700ms median (-22% vs baseline)');
  });

  it('appends an attempt to the latest round', async () => {
    await appendPerfRound(file, { date: '2026-09-01', title: 'boot', attempts: [] });
    await appendPerfRound(file, { date: '2026-09-02', title: 'search', attempts: [] });
    const doc = await appendPerfAttempt(file, {
      outcome: 'KEPT',
      summary: 'index the field',
      result: '40ms (-80%)',
    });
    expect(latestRound(doc, 'search')?.attempts).toHaveLength(1);
    expect(latestRound(doc, 'boot')?.attempts).toHaveLength(0);
  });

  it('appends to a named round when asked', async () => {
    await appendPerfRound(file, { date: '2026-09-01', title: 'boot', attempts: [] });
    await appendPerfRound(file, { date: '2026-09-02', title: 'search', attempts: [] });
    const doc = await appendPerfAttempt(
      file,
      { outcome: 'REVERTED', summary: 'prefetch', result: 'within noise' },
      { title: 'boot' },
    );
    expect(latestRound(doc, 'boot')?.attempts).toHaveLength(1);
  });

  it('refuses to log an attempt with no baseline round to attach it to', async () => {
    await expect(
      appendPerfAttempt(file, { outcome: 'KEPT', summary: 'x', result: 'y' }),
    ).rejects.toThrow(/record a baseline/);
    await appendPerfRound(file, { date: '2026-09-01', title: 'boot', attempts: [] });
    await expect(
      appendPerfAttempt(file, { outcome: 'KEPT', summary: 'x', result: 'y' }, { title: 'ghost' }),
    ).rejects.toThrow(/no round titled "ghost"/);
  });
});

describe('summarizePerfLog', () => {
  it('counts kept and reverted attempts per round', () => {
    expect(summarizePerfLog(parsePerfLog(SAMPLE))[0]).toBe(
      '2026-09-01  parser throughput — 2 kept / 1 reverted — 301ms median, 340MB allocs, 58k allocs/op (-27% wall vs baseline)',
    );
  });
});
