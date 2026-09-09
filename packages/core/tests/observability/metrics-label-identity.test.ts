/**
 * Label-set identity for `InMemoryMetricsSink` (WS: unescaped label encoding).
 *
 * Series identity is a string built from a label SET (`labelKey`), and the
 * snapshot exporter decodes it back (`parseLabelKey`). Both must satisfy two
 * properties, which are what these tests pin:
 *
 *   1. injective — two distinct label sets never share an identity, so their
 *      observations never merge into one series;
 *   2. round-trip — the labels reported by `snapshot()` are exactly the labels
 *      that were recorded.
 *
 * Before the fix the encoding joined `k=v` with `,` and `=` unescaped, so
 * `{a:'1', b:'2'}` and `{a:'1,b=2'}` produced the SAME key. The consequences
 * were silent and downstream: counter sums merged across unrelated series, a
 * gauge from one series was overwritten by another, histogram samples pooled,
 * `{job:'deploy, notify'}` scraped as `{job="deploy"}`, and the
 * `maxSeriesPerMetric` cardinality cap under-counted and stopped dropping.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryMetricsSink } from '../../src/observability/metrics.js';
import { renderPrometheus } from '../../src/observability/prometheus.js';

describe('InMemoryMetricsSink label-set identity', () => {
  it('keeps distinct label sets as distinct series when a value contains a delimiter', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('x_total', 1, { a: '1', b: '2' });
    sink.counter('x_total', 1, { a: '1,b=2' });

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(2);
    const byJob = new Map(
      snap.series.map((s) => [JSON.stringify(sorted(s.labels)), s.values.value ?? 0]),
    );
    // Neither series absorbs the other's observation.
    expect(byJob.get(JSON.stringify(sorted({ a: '1', b: '2' })))).toBe(1);
    expect(byJob.get(JSON.stringify(sorted({ a: '1,b=2' })))).toBe(1);
  });

  it('reports recorded labels exactly when a value contains a comma', () => {
    const sink = new InMemoryMetricsSink();
    const recorded = { job: 'deploy, notify' };
    sink.counter('cron_job_fired_total', 5, recorded);

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(1);
    // Was {job:'deploy'} — the value was truncated at the comma and the
    // remainder dropped, inventing a series that never existed.
    expect(snap.series[0]?.labels).toEqual(recorded);
    expect(snap.series[0]?.values.value).toBe(5);
  });

  it.each([
    ['comma', { job: 'build, test' }],
    ['equals', { cmd: 'git commit -m a=b' }],
    ['backslash', { path: 'C:\\Users\\x' }],
    ['backslash before a delimiter', { weird: 'a\\,b\\=c' }],
    ['all three', { gnarly: 'a, b=c \\d\\,e=f' }],
    ['empty value', { flag: '' }],
    ['value of only delimiters', { edge: ',,==,' }],
    ['unicode', { model: 'gpt-4-∞, turbo' }],
  ])('round-trips a label value containing %s', (_case, labels) => {
    const sink = new InMemoryMetricsSink();
    sink.counter('rt_total', 1, labels);

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(1);
    expect(snap.series[0]?.labels).toEqual(labels);
  });

  it('round-trips a label NAME containing a delimiter', () => {
    const sink = new InMemoryMetricsSink();
    const labels = { 'weird,key': 'v' };
    sink.counter('rn_total', 2, labels);

    expect(sink.snapshot().series[0]?.labels).toEqual(labels);
  });

  it('applies the same identity to gauges', () => {
    const sink = new InMemoryMetricsSink();
    // Gauge is last-write-wins, so a collision silently replaced one series
    // with another's value instead of keeping both.
    sink.gauge('active', 1, { a: '1,b=2' });
    sink.gauge('active', 7, { a: '1', b: '2' });

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(2);
    // Exact label SETS, so this also fails if decoding fabricates a `b` key on
    // the single-label series (the pre-fix `split(',')` did exactly that).
    expect(
      snap.series.map((s) => `${JSON.stringify(sorted(s.labels))}=${s.values.value}`).sort(),
    ).toEqual([
      `${JSON.stringify(sorted({ a: '1', b: '2' }))}=7`,
      `${JSON.stringify(sorted({ a: '1,b=2' }))}=1`,
    ]);
  });

  it('applies the same identity to histograms', () => {
    const sink = new InMemoryMetricsSink();
    sink.histogram('lat_ms', 10, { a: '1,b=2' });
    sink.histogram('lat_ms', 20, { a: '1', b: '2' });

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(2);
    // Samples pooled before the fix: one series with count 2.
    for (const s of snap.series) expect(s.values.count).toBe(1);
  });

  it('carries the full label value into the Prometheus exposition', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('cron_job_fired_total', 5, { job: 'deploy, notify' });

    const out = renderPrometheus(sink.snapshot());
    expect(out).toContain('cron_job_fired_total{job="deploy, notify"} 5');
    expect(out).not.toContain('cron_job_fired_total{job="deploy"}');
  });

  it('counts real distinct series against maxSeriesPerMetric', () => {
    const sink = new InMemoryMetricsSink({ maxSeriesPerMetric: 2 });
    sink.counter('c_total', 1, { a: '1', b: '2' });
    sink.counter('c_total', 1, { a: '1,b=2' });
    sink.counter('c_total', 1, { z: '9' });

    // Three genuinely distinct sets vs a cap of 2 => exactly one drop. When the
    // first two collided they looked like one series, so nothing was dropped
    // while data was being merged instead.
    expect(sink.droppedObservations()).toBe(1);
    expect(sink.droppedFor('c_total')).toBe(1);
  });

  // --- Guard the cheap, common paths against collateral change -------------

  it('treats label key order as the same series', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('o_total', 1, { a: '1', b: '2' });
    sink.counter('o_total', 1, { b: '2', a: '1' });

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(1);
    expect(snap.series[0]?.values.value).toBe(2);
  });

  it('keeps delimiter-free labels byte-identical to their pre-encoding form', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('plain_total', 3, { tool: 'read', ok: 'true' });

    const snap = sink.snapshot();
    expect(snap.series).toHaveLength(1);
    expect(snap.series[0]?.labels).toEqual({ ok: 'true', tool: 'read' });
  });

  it('keeps unlabeled, empty-labeled, and labeled series separate as before', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('f_total');
    sink.counter('f_total', 3);
    sink.counter('f_total', 1, {});
    sink.counter('f_total', 1, { tool: 'read' });

    const snap = sink.snapshot();
    const unlabeled = snap.series.filter((s) => !s.labels.tool);
    const labeled = snap.series.filter((s) => s.labels.tool === 'read');
    // `{}` and `undefined` both mean "no labels" and share one identity.
    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.values.value).toBe(1);
    expect(unlabeled).toHaveLength(1);
    expect(unlabeled[0]?.values.value).toBe(5);
  });
});

function sorted(labels: Record<string, string>): [string, string][] {
  return Object.entries(labels).sort(([x], [y]) => x.localeCompare(y));
}
