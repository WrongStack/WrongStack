/**
 * HQ system-health payload shapes and the cockpit digest built from them.
 *
 * @module domain/system-health
 */

export interface SystemHealth {
  status: 'healthy' | 'degraded';
  uptime: { serverTime: string; eventLogSize: number };
  stores: { events: string; timeseries: string; kanban: string };
  connections: { total: number; active: number; stale: number };
  /** Per-client refresh staleness — the server-side sign of a backed-up publisher. */
  publisherHealth?: { clientId: string; staleness: 'fresh' | 'quiet' | 'stale' }[];
}

export interface MailboxGatewayHealth {
  gatewayCount: number;
  gateways: { projectId: string; hasActiveStreams: boolean }[];
}

/**
 * The parts of the health payloads the card used to drop on the floor: WHICH
 * store degraded (the card only said "degraded"), publisher staleness, and the
 * mailbox gateways `/api/health/mailbox` exists to report.
 */
export function summarizeHealthDetail(
  health: Pick<SystemHealth, 'stores' | 'publisherHealth'>,
  gateways: MailboxGatewayHealth | null,
): {
  degradedStores: string[];
  publishers: { fresh: number; quiet: number; stale: number };
  gateways: { total: number; streaming: number } | null;
} {
  const degradedStores = Object.entries(health.stores ?? {})
    .filter(([, state]) => state !== 'ok')
    .map(([name]) => name);
  const publishers = { fresh: 0, quiet: 0, stale: 0 };
  for (const entry of health.publisherHealth ?? []) publishers[entry.staleness] += 1;
  return {
    degradedStores,
    publishers,
    gateways:
      gateways === null
        ? null
        : {
            total: gateways.gatewayCount,
            streaming: gateways.gateways.filter((gateway) => gateway.hasActiveStreams).length,
          },
  };
}
