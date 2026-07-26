import { useCallback, useEffect, useState } from 'react';

import { sendRosterMessage } from '@/lib/roster-ws';
import { getWSClient } from '@/lib/ws-client';
import {
  type CustomRosterStats,
  KNOWN_ROLES,
  ROSTER_UPDATE_DEBOUNCE_MS,
  type RosterAgentEntry,
} from './agent-roster-data.js';

export function useAgentRosterData(): {
  customStats: CustomRosterStats[];
  catalog: RosterAgentEntry[];
  rosterLoading: boolean;
  rosterError: string | null;
  loadRoster: () => Promise<void>;
} {
  const [customStats, setCustomStats] = useState<CustomRosterStats[]>([]);
  const [catalog, setCatalog] = useState<RosterAgentEntry[]>(KNOWN_ROLES);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    setRosterLoading(true);
    setRosterError(null);
    try {
      const data = (await sendRosterMessage('agent-roster.list', {})) as {
        roles: string[];
        stats: CustomRosterStats[];
        catalog?: RosterAgentEntry[];
      };
      if (data.stats) setCustomStats(data.stats);
      if (data.catalog?.length) setCatalog(data.catalog);
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : 'Failed to load roster');
    }
    setRosterLoading(false);
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = getWSClient().on('agent-roster.updated', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadRoster();
      }, ROSTER_UPDATE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [loadRoster]);

  return { customStats, catalog, rosterLoading, rosterError, loadRoster };
}
