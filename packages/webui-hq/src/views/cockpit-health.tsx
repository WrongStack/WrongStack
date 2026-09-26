/**
 * Cockpit "System health" tiles and the digest behind them.
 *
 * @module views/cockpit-health
 */
import type * as React from 'react';
import { StatTile } from '../components/hq/primitives.js';
import {
  type MailboxGatewayHealth,
  type SystemHealth,
  summarizeHealthDetail,
} from '../domain/system-health.js';

export type { MailboxGatewayHealth, SystemHealth };

export function SystemHealthTiles({
  health,
  gatewayHealth,
}: {
  health: SystemHealth;
  gatewayHealth: MailboxGatewayHealth | null;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <StatTile
        label="status"
        value={health.status}
        tone={health.status === 'healthy' ? 'active' : 'error'}
      />
      <StatTile label="event log" value={health.uptime?.eventLogSize ?? 0} />
      <StatTile label="connections" value={health.connections?.total ?? 0} />
      <StatTile
        label="active"
        value={health.connections?.active ?? 0}
        tone={(health.connections?.active ?? 0) > 0 ? 'active' : 'idle'}
      />
      <StatTile
        label="stale"
        value={health.connections?.stale ?? 0}
        tone={(health.connections?.stale ?? 0) > 3 ? 'warn' : 'idle'}
      />
      {(() => {
        const detail = summarizeHealthDetail(health, gatewayHealth);
        return (
          <>
            <StatTile
              label="stores"
              value={detail.degradedStores.length === 0 ? 'ok' : detail.degradedStores.join(', ')}
              tone={detail.degradedStores.length === 0 ? 'active' : 'error'}
            />
            <StatTile
              label="publishers"
              value={`${detail.publishers.fresh} fresh · ${detail.publishers.stale} stale`}
              tone={detail.publishers.stale > 0 ? 'warn' : 'idle'}
            />
            {detail.gateways !== null && (
              <StatTile
                label="mailbox gateways"
                value={`${detail.gateways.total} · ${detail.gateways.streaming} streaming`}
              />
            )}
          </>
        );
      })()}
    </div>
  );
}
