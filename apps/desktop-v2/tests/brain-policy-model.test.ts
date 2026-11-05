import { expect, it } from 'vitest';
import {
  brainDraft,
  brainMonitorResetPatch,
  brainPatch,
  brainSnapshot,
} from '../src/brain-policy-model';

const snapshot = {
  mode: 'headless',
  maxAutoRisk: 'low',
  models: [],
  council: { enabled: true, configured: undefined, quorum: 0.5 },
  cache: { enabled: false, ttlMs: 300000, maxEntries: 200, hits: 1 },
  decisionTimeoutMs: 45000,
};
it('projects configured council intent separately from effective state and ignores live metrics', () => {
  const base = brainDraft(brainSnapshot({ config: snapshot }));
  expect(base['council.enabled']).toBe('');
  const edited = { ...base, 'cache.enabled': true, decisionTimeoutMs: '' };
  expect(
    brainPatch(base, edited, brainDraft({ ...snapshot, cache: { ...snapshot.cache, hits: 12 } })),
  ).toEqual({ cache: { enabled: true }, decisionTimeoutMs: null });
  expect(brainPatch(base, base, base)).toEqual({});
  expect(() => brainSnapshot({ config: {} })).toThrow(/readable Brain/);
});
it('refuses stale edited values and validates numeric bounds before any write', () => {
  const base = brainDraft(snapshot);
  expect(() =>
    brainPatch(base, { ...base, maxAutoRisk: 'high' }, { ...base, maxAutoRisk: 'medium' }),
  ).toThrow(/changed elsewhere/);
  expect(
    brainPatch(base, { ...base, maxAutoRisk: 'high' }, { ...base, maxAutoRisk: 'high' }),
  ).toEqual({ maxAutoRisk: 'high' });
  // Durations are edited in seconds and written in milliseconds.
  expect(base['decisionTimeoutMs']).toBe('45');
  expect(base['cache.ttlMs']).toBe('300');
  expect(brainPatch(base, { ...base, decisionTimeoutMs: '1.5' }, base)).toEqual({
    decisionTimeoutMs: 1500,
  });
  for (const value of ['0', '-1', '0.0001', 'Infinity', 'bad'])
    expect(() => brainPatch(base, { ...base, decisionTimeoutMs: value }, base)).toThrow(
      /valid number/,
    );
  expect(() => brainPatch(base, { ...base, decisionLogMaxEntries: '1.5' }, base)).toThrow(
    /whole number/,
  );
  expect(() => brainPatch(base, { ...base, 'council.maxConcurrency': '9' }, base)).toThrow(
    /allowed range/,
  );
  expect(
    brainPatch(base, { ...base, humanTimeoutMs: '0', 'llm.minConfidence': '0.75' }, base),
  ).toEqual({ humanTimeoutMs: 0, llm: { minConfidence: 0.75 } });
});
it('preserves independent and unrecognized monitor signals with nested edits', () => {
  const raw = {
    ...snapshot,
    monitor: {
      signals: { toolFailureStreak: false, fileChurn: true, futureSignal: false },
      cooldownMs: 123456,
    },
  };
  const base = brainDraft(raw);
  const current = {
    ...raw,
    monitor: { ...raw.monitor, signals: { ...raw.monitor.signals, agentStall: false } },
  };
  const draft = {
    ...base,
    'monitor.signals.fileChurn': 'false',
    'monitor.fileEditTools': 'write\n custom_patch\n',
    'monitor.stallMs': '0',
  };
  expect(brainPatch(base, draft, brainDraft(current), current)).toEqual({
    monitor: {
      signals: {
        toolFailureStreak: false,
        fileChurn: false,
        futureSignal: false,
        agentStall: false,
      },
      fileEditTools: ['write', 'custom_patch'],
      stallMs: 0,
    },
  });
  expect(raw.monitor.signals.fileChurn).toBe(true);
  expect(() => brainPatch(base, draft, base)).toThrow(/Refresh the Brain/);
  const other = { ...base, 'monitor.signals.fileChurn': 'false' };
  expect(() =>
    brainPatch(
      base,
      { ...base, 'monitor.cooldownMs': '999' },
      { ...other, 'monitor.cooldownMs': '888' },
      current,
    ),
  ).toThrow(/changed elsewhere/);
});
it('clears trace destinations with the canonical empty string and validates trace capacity', () => {
  const base = brainDraft({
    ...snapshot,
    trace: { path: '/old/trace.jsonl', maxOpenRecords: 777 },
  });
  expect(
    brainPatch(base, { ...base, 'trace.path': '', 'trace.maxOpenRecords': '1024' }, base),
  ).toEqual({ trace: { path: '', maxOpenRecords: 1024 } });
  expect(() => brainPatch(base, { ...base, 'trace.maxOpenRecords': '0' }, base)).toThrow(
    /allowed range/,
  );
  expect(brainPatch(base, { ...base, 'monitor.fileEditTools': '' }, base)).toEqual({
    monitor: { fileEditTools: [] },
  });
});
it('resets the complete monitor override only against its observed revision, retaining other policies', () => {
  const baseline = {
    ...snapshot,
    monitor: { enabled: false, signals: { futureSignal: true }, fileEditTools: [] },
  };
  expect(brainMonitorResetPatch(baseline, baseline)).toEqual({ monitor: null });
  expect(brainMonitorResetPatch(baseline, { ...baseline, trace: { enabled: true } })).toEqual({
    monitor: null,
  });
  expect(() =>
    brainMonitorResetPatch(baseline, {
      ...baseline,
      monitor: { ...baseline.monitor, futureThreshold: 17 },
    }),
  ).toThrow(/changed elsewhere/);
  expect(brainMonitorResetPatch(baseline, { monitor: {} })).toEqual({ monitor: null });
  expect(brainMonitorResetPatch({}, {})).toEqual({ monitor: null });
  expect(baseline.monitor.fileEditTools).toEqual([]);
});
