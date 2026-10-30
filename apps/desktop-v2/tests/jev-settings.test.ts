import { expect, it } from 'vitest';
import { jevState } from '../src/JevSettings';

it('reads Jev settings, checks and activity without secret values', () => {
  const state = jevState({
    settings: {
      enabled: true,
      status: 'ready',
      route: 'typesafe',
      model: 'jev-1',
      endpoint: 'https://api.example/v1',
      requestTimeoutMs: 4000,
      keySource: 'config',
      features: { tool: true, compaction: false },
      readiness: { tool: { state: 'active', reason: '' } },
      logContent: false,
    },
    checks: {
      running: false,
      report: {
        passed: 1,
        total: 2,
        model: 'jev-1',
        cases: [
          { feature: 'tool', name: 'rm -rf', ok: true, expected: 'high', actual: 'high' },
          { feature: 'compaction', name: 'keep', ok: false, expected: 'keep', actual: 'drop' },
        ],
      },
    },
    activity: { entries: [{ at: 5, feature: 'tool', outcome: 'answered', durationMs: 120 }] },
    message: 'Saved.',
  });
  expect(state).toMatchObject({
    enabled: true,
    keySource: 'config',
    features: { tool: true, compaction: false },
    readiness: { tool: { state: 'active' } },
    message: 'Saved.',
  });
  expect(state.checks.report?.cases[1]).toMatchObject({ ok: false, actual: 'drop' });
  expect(state.activity[0]).toEqual({
    at: 5,
    feature: 'tool',
    outcome: 'answered',
    durationMs: 120,
    reason: '',
  });
  expect(jevState({}).keySource).toBe('none');
  expect(jevState({}).checks.report).toBeNull();
});
