import { PERF_METRIC_IDS, PERF_MODE_IDS, PERF_MODES } from '@wrongstack/core/performance';
import { describe, expect, it } from 'vitest';
import {
  buildPerfRunMessage,
  PERF_MODE_SLUGS,
  PERF_MUTATING_MODES,
  PERF_RUN_METRIC_LABELS,
  PERF_RUN_METRICS,
  PERF_RUN_MODE_LABELS,
  PERF_RUN_MODES,
  parsePerfRunMessage,
} from '@/lib/perf-run-message';

describe('perf run message', () => {
  it('round-trips scope, mode, and metric', () => {
    const summary = { scope: 'packages/sage', mode: 'cpu', metric: 'p99-latency-ms' } as const;
    const text = buildPerfRunMessage('BODY', summary);
    expect(text.endsWith('BODY')).toBe(true);
    expect(parsePerfRunMessage(text)).toEqual(summary);
  });

  it('survives a scope with characters that would break the marker', () => {
    const summary = { scope: 'packages/a "b" & c', mode: 'ratchet', metric: '' } as const;
    expect(parsePerfRunMessage(buildPerfRunMessage('BODY', summary))).toEqual(summary);
  });

  it('returns undefined for ordinary messages', () => {
    expect(parsePerfRunMessage('just a message')).toBeUndefined();
    expect(parsePerfRunMessage('')).toBeUndefined();
    // The sibling card's marker must not be mistaken for this one.
    expect(
      parsePerfRunMessage('<!-- wrongstack-bug-hunt scope="" max-bugs="1" -->\nBODY'),
    ).toBeUndefined();
  });

  it('falls back to plain rendering for a mode this build does not know', () => {
    // A marker written by a newer build: rendering an unknown chip would be
    // worse than showing the message as ordinary text.
    const text = '<!-- wrongstack-perf-run scope="" mode="quantum" metric="" -->\nBODY';
    expect(parsePerfRunMessage(text)).toBeUndefined();
  });

  it('drops an unknown metric but keeps the round', () => {
    const text = '<!-- wrongstack-perf-run scope="x" mode="audit" metric="vibes" -->\nBODY';
    expect(parsePerfRunMessage(text)).toEqual({ scope: 'x', mode: 'audit', metric: '' });
  });

  it('tolerates a malformed percent-escape in the scope', () => {
    const text = '<!-- wrongstack-perf-run scope="%E0%A4%A" mode="audit" metric="" -->\nBODY';
    expect(parsePerfRunMessage(text)).toBeUndefined();
  });
});

describe('parity with @wrongstack/core/performance', () => {
  it('lists exactly the modes core defines', () => {
    expect([...PERF_RUN_MODES].sort()).toEqual([...PERF_MODE_IDS].sort());
  });

  it('lists exactly the metrics core defines', () => {
    expect([...PERF_RUN_METRICS].sort()).toEqual([...PERF_METRIC_IDS].sort());
  });

  it('maps every mode to the slug core resolves it to', () => {
    // A drifted slug here is a 404 at click time, with no compile error to
    // catch it — the WebUI asks the server for the prompt by name.
    for (const id of PERF_MODE_IDS) {
      expect(PERF_MODE_SLUGS[id], id).toBe(PERF_MODES[id].slug);
    }
  });

  it('agrees with core about which modes may change code', () => {
    for (const id of PERF_MODE_IDS) {
      expect(PERF_MUTATING_MODES.has(id), id).toBe(PERF_MODES[id].mutating);
    }
  });

  it('labels every mode and metric', () => {
    for (const mode of PERF_RUN_MODES) expect(PERF_RUN_MODE_LABELS[mode]).toBeTruthy();
    for (const metric of PERF_RUN_METRICS) expect(PERF_RUN_METRIC_LABELS[metric]).toBeTruthy();
  });
});
