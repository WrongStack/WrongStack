import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';

/**
 * Provider names by id from the engine's provider catalog. The saved-provider list carries only
 * ids ("minimax-coding-plan"), which settings pages showed as their names.
 */
export function useProviderNames(command: EngineCommand): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void command('providers.list', {}, ['provider.catalog'])
      .then((reply) => {
        if (!active) return;
        const next: Record<string, string> = {};
        for (const row of entries(reply['providers']))
          if (typeof row['id'] === 'string' && typeof row['name'] === 'string')
            next[row['id']] = row['name'];
        setNames(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [command]);
  return names;
}
