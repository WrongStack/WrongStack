import { describe, expect, it } from 'vitest';
import { formatSageDoctorReport } from '../src/doctor-format.js';
import type { SageDoctorReport } from '../src/memory-doctor-types.js';

describe('formatSageDoctorReport non-finite metrics', () => {
  it('falls back cleanly for NaN/negative byte counts and non-finite precision', () => {
    const report = {
      metrics: {
        active: 10,
        total: 12,
        edges: 4,
        pendingCandidates: 1,
        dbBytes: Number.NaN,
        walBytes: -1024,
        injections: 10,
        uses: 5,
        precision: Number.NaN,
        injectedNeverUsed: 0,
        unanchoredActive: 0,
        neverVerifiedActive: 0,
      },
      checks: [],
    } as unknown as SageDoctorReport;

    const output = formatSageDoctorReport(report);
    expect(output).not.toContain('NaN');
    expect(output).toContain('database ?, WAL ?');
    expect(output).toContain('precision 0.0%');
  });
});
