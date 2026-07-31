import type {
  MetricLabels,
  MetricSeries,
  MetricsSink,
  MetricsSnapshot,
} from '../types/observability.js';

interface CounterState {
  value: number;
}

interface GaugeState {
  value: number;
}

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  // Reservoir sample for cheap quantile estimates. 1024 samples gives <2% error
  // on p99 for typical agent workloads — small memory footprint, no exporter
  // dependency. Swap for HdrHistogram if you need bounded-error guarantees.
  samples: number[];
}

const RESERVOIR_SIZE = 1024;

export interface InMemoryMetricsSinkOptions {
  /**
   * Hard cap on the number of distinct label combinations retained per metric
   * (counter, gauge, or histogram). Past the cap, new observations are
   * dropped instead of allocating a new series. `undefined` means no cap;
   * `0` or any non-positive value is normalized to no cap.
   */
  maxSeriesPerMetric?: number | undefined;
}

function labelKey(labels: MetricLabels | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? 0;
}

/**
 * In-memory metrics sink. Suitable for embedded use, tests, and /metrics
 * scrape over HTTP. For production push-based pipelines, write an adapter
 * that implements MetricsSink and forwards to OTLP/StatsD/Prometheus.
 */
export class InMemoryMetricsSink implements MetricsSink {
  private counters = new Map<string, Map<string, CounterState>>();
  private gauges = new Map<string, Map<string, GaugeState>>();
  private histograms = new Map<string, Map<string, HistogramState>>();
  /**
   * Per-metric dropped observation counts. Keyed by the metric's full name
   * (counter / gauge / histogram families share a name space by convention;
   * families are tracked in the respective `droppedByMetric` Map).
   */
  private droppedByMetric = new Map<string, number>();
  private readonly maxSeriesPerMetric: number | undefined;

  constructor(opts: InMemoryMetricsSinkOptions = {}) {
    // Normalize: undefined OR non-positive → no cap. Prevents a misconfigured
    // value from silently dropping every observation.
    const cap = opts.maxSeriesPerMetric;
    this.maxSeriesPerMetric = cap !== undefined && cap > 0 ? cap : undefined;
  }

  counter(name: string, value = 1, labels?: MetricLabels): void {
    if (this.maxSeriesPerMetric !== undefined) {
      const series = this.counters.get(name) ?? new Map<string, CounterState>();
      if (!series.has(labelKey(labels)) && series.size >= this.maxSeriesPerMetric) {
        this.recordDrop(name);
        return;
      }
    }
    const series = this.getOrCreate(this.counters, name);
    const key = labelKey(labels);
    const state = series.get(key) ?? { value: 0 };
    state.value += value;
    series.set(key, state);
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    if (this.maxSeriesPerMetric !== undefined) {
      const series = this.gauges.get(name) ?? new Map<string, GaugeState>();
      if (!series.has(labelKey(labels)) && series.size >= this.maxSeriesPerMetric) {
        this.recordDrop(name);
        return;
      }
    }
    const series = this.getOrCreate(this.gauges, name);
    series.set(labelKey(labels), { value });
  }

  histogram(name: string, value: number, labels?: MetricLabels): void {
    if (this.maxSeriesPerMetric !== undefined) {
      const series = this.histograms.get(name) ?? new Map<string, HistogramState>();
      if (!series.has(labelKey(labels)) && series.size >= this.maxSeriesPerMetric) {
        this.recordDrop(name);
        return;
      }
    }
    const series = this.getOrCreate(this.histograms, name);
    const key = labelKey(labels);
    const existing = series.get(key);
    if (!existing) {
      const created: HistogramState = { count: 0, sum: 0, min: value, max: value, samples: [] };
      series.set(key, created);
      this.advanceHistogram(created, value);
      return;
    }
    this.advanceHistogram(existing, value);
  }

  private advanceHistogram(state: HistogramState, value: number): void {
    state.count++;
    state.sum += value;
    if (value < state.min) state.min = value;
    if (value > state.max) state.max = value;
    if (state.samples.length < RESERVOIR_SIZE) {
      state.samples.push(value);
    } else {
      // Vitter's Algorithm R — every new value has size/count chance of replacing.
      const r = Math.floor(Math.random() * state.count);
      if (r < RESERVOIR_SIZE) state.samples[r] = value;
    }
  }

  snapshot(): MetricsSnapshot {
    const series: MetricSeries[] = [];

    for (const [name, byLabel] of this.counters) {
      for (const [key, state] of byLabel) {
        series.push({
          name,
          type: 'counter',
          labels: parseLabelKey(key),
          values: { value: state.value },
        });
      }
    }

    for (const [name, byLabel] of this.gauges) {
      for (const [key, state] of byLabel) {
        series.push({
          name,
          type: 'gauge',
          labels: parseLabelKey(key),
          values: { value: state.value },
        });
      }
    }

    for (const [name, byLabel] of this.histograms) {
      for (const [key, state] of byLabel) {
        const sorted = [...state.samples].sort((a, b) => a - b);
        series.push({
          name,
          type: 'histogram',
          labels: parseLabelKey(key),
          values: {
            count: state.count,
            sum: state.sum,
            min: state.min,
            max: state.max,
            p50: quantile(sorted, 0.5),
            p95: quantile(sorted, 0.95),
            p99: quantile(sorted, 0.99),
          },
        });
      }
    }

    return { timestamp: Date.now(), series, droppedObservations: this.droppedByMetricSnapshot() };
  }

  /**
   * Cumulative drop counts across all metrics. Use to detect cardinality
   * explosions (drift upward) without scraping the full snapshot. Returns 0
   * for a sink created without `maxSeriesPerMetric`.
   */
  droppedObservations(): number {
    let total = 0;
    for (const n of this.droppedByMetric.values()) total += n;
    return total;
  }

  /**
   * Drop count for a single metric, or 0 if no drops have been recorded.
   * Cheaper than `droppedObservations()` for one-name lookups.
   */
  droppedFor(name: string): number {
    return this.droppedByMetric.get(name) ?? 0;
  }

  /**
   * Snapshot of per-metric drop counts. `undefined` for sinks without a cap
   * (caller can treat the absence as "no drops possible"). For capped sinks
   * an empty object means "cap set, no drops yet".
   */
  private droppedByMetricSnapshot(): Record<string, number> | undefined {
    if (this.maxSeriesPerMetric === undefined) return undefined;
    if (this.droppedByMetric.size === 0) return {};
    return Object.fromEntries(this.droppedByMetric);
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.droppedByMetric.clear();
  }

  private getOrCreate<V>(bag: Map<string, Map<string, V>>, name: string): Map<string, V> {
    let series = bag.get(name);
    if (!series) {
      series = new Map();
      bag.set(name, series);
    }
    return series;
  }

  private recordDrop(name: string): void {
    this.droppedByMetric.set(name, (this.droppedByMetric.get(name) ?? 0) + 1);
  }
}

function parseLabelKey(key: string): MetricLabels {
  if (!key) return {};
  const labels: MetricLabels = {};
  for (const pair of key.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

/** Cheap noop sink — drop-in default when observability is not configured. */
export class NoopMetricsSink implements MetricsSink {
  counter(): void {}
  gauge(): void {}
  histogram(): void {}
  snapshot(): MetricsSnapshot {
    return { timestamp: Date.now(), series: [] };
  }
  droppedObservations(): number {
    return 0;
  }
  reset(): void {}
}
