/** HQ server health for the Overview: `/api/system/health` plus the optional mailbox gateways. */
import { useEffect, useState } from 'react';
import { fetchJson } from '../data/api.js';
import type { MailboxGatewayHealth, SystemHealth } from '../domain/system-health.js';

const HEALTH_POLL_MS = 30_000;

/** `/api/system/health` (required) and `/api/health/mailbox` (optional), polled together. */
export function useCockpitHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [gatewayHealth, setGatewayHealth] = useState<MailboxGatewayHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<SystemHealth>('/api/system/health')
        .then((data) => {
          if (cancelled) return;
          setHealth(data);
          setHealthError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setHealthError(cause instanceof Error ? cause.message : String(cause));
        });
      // Optional detail: an older server without the route simply shows none.
      fetchJson<MailboxGatewayHealth>('/api/health/mailbox')
        .then((data) => {
          if (!cancelled) setGatewayHealth(data);
        })
        .catch(() => {
          if (!cancelled) setGatewayHealth(null);
        });
    };
    load();
    const timer = window.setInterval(load, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { health, healthError, gatewayHealth };
}
