/**
 * The System health card used to say only "degraded" — not which store — and
 * dropped publisher staleness and mailbox-gateway health the server already
 * computes.
 */
import { describe, expect, it } from 'vitest';
import { summarizeHealthDetail } from '../src/domain/system-health.js';

describe('summarizeHealthDetail', () => {
  it('names degraded stores and buckets publisher staleness', () => {
    const detail = summarizeHealthDetail(
      {
        stores: { events: 'ok', timeseries: 'degraded', kanban: 'ok' },
        publisherHealth: [
          { clientId: 'a', staleness: 'fresh' },
          { clientId: 'b', staleness: 'stale' },
          { clientId: 'c', staleness: 'fresh' },
        ],
      },
      {
        gatewayCount: 2,
        gateways: [
          { projectId: 'p1', hasActiveStreams: true },
          { projectId: 'p2', hasActiveStreams: false },
        ],
      },
    );
    expect(detail.degradedStores).toEqual(['timeseries']);
    expect(detail.publishers).toEqual({ fresh: 2, quiet: 0, stale: 1 });
    expect(detail.gateways).toEqual({ total: 2, streaming: 1 });
  });

  it('tolerates an older server that sends neither detail', () => {
    const detail = summarizeHealthDetail(
      { stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' } },
      null,
    );
    expect(detail).toEqual({
      degradedStores: [],
      publishers: { fresh: 0, quiet: 0, stale: 0 },
      gateways: null,
    });
  });
});
