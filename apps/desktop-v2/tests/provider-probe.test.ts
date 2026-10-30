import { expect, it } from 'vitest';
import { probeOutcome } from '../src/ProviderProbe';

it('describes a probe result without claiming more than reachability', () => {
  expect(
    probeOutcome({ ok: true, status: 'ok', httpStatus: 200, elapsedMs: 84, modelCount: 3 }),
  ).toBe('Reachable · HTTP 200 · 84 ms · 3 models listed');
  expect(probeOutcome({ ok: false, status: 'unreachable', detail: 'ECONNREFUSED' })).toBe(
    'Unreachable · ECONNREFUSED',
  );
  expect(probeOutcome({ ok: false, status: 'no_base_url' })).toBe(
    'No endpoint URL to check (a built-in provider)',
  );
});
