import type { EventBus } from '@wrongstack/core/kernel';
import type { WebuiDeps, WebuiMutableState } from './routes.js';
import { startTerminalDashboard } from './terminal-dashboard.js';
import type { ConnectedClient } from './types.js';
import { startWebUILiveStatusLogger } from './webui-status-logger.js';
import { buildWebUIAccessUrl } from './ws-utils.js';

export function setupWebuiTerminalLogging(params: {
  wsHost: string;
  httpPort: number;
  accessToken: string;
  publicUrl: string | undefined;
  events: EventBus;
  clients: Map<unknown, ConnectedClient>;
  state: WebuiMutableState;
  deps: WebuiDeps;
}): {
  terminalDashboard: ReturnType<typeof startTerminalDashboard>;
  stopLiveStatusLogger: () => void;
} {
  const { wsHost, httpPort, accessToken, publicUrl, events, clients, state, deps } = params;

  const terminalDashboard = startTerminalDashboard({
    title: 'WebUI',
    getUrl: () =>
      buildWebUIAccessUrl({
        host: wsHost,
        port: httpPort,
        token: accessToken,
        publicUrl,
      }),
  });

  const stopLiveStatusLogger = startWebUILiveStatusLogger({
    events,
    dashboard: terminalDashboard,
    getSessionList: () => {
      const activeIds = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId) activeIds.add(client.sessionId);
        for (const id of client.sessionIds ?? []) activeIds.add(id);
      }
      const currentId = state.getSession().id;
      if (activeIds.size === 0 && currentId) {
        activeIds.add(currentId);
      }
      return Array.from(activeIds).map((id) => {
        const ag = deps.peekAgent?.(id) ?? undefined;
        const cfg = state.getConfig();
        const isRunning = state.isRunActive(id);
        return {
          id,
          model: ag?.ctx?.model ?? cfg.model,
          provider: ag?.ctx?.provider?.id ?? cfg.provider,
          isRunning,
        };
      });
    },
  });

  return { terminalDashboard, stopLiveStatusLogger };
}
