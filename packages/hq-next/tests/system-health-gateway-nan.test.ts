import { describe, expect, it } from 'vitest';
import { summarizeHealthDetail } from '../src/hq/domain/system-health';

describe('summarizeHealthDetail gatewayCount guard', () => {
  it('falls back to gateways.length when gatewayCount is NaN or negative', () => {
    const res = summarizeHealthDetail(
      { stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' } },
      { gatewayCount: Number.NaN, gateways: [{ projectId: 'p1', hasActiveStreams: true }] },
    );
    expect(res.gateways).toEqual({ total: 1, streaming: 1 });
  });
});
