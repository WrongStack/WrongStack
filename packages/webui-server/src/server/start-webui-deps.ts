import type { WebSocket } from 'ws';
import type { StandaloneSessionIdentityLifecycle } from './standalone-session-identity.js';
import type { WebuiCallbacks, WebuiDeps } from './routes.js';
import type { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
import type { ConnectedClient } from './types.js';

/**
 * Everything `createWebuiDeps` passes straight through, taken FROM the
 * `WebuiDeps` contract rather than restated. The decomposition that split
 * this helper out of `start-webui.ts` retyped all 46 fields as `any`, which
 * turned the deps object — the single wiring surface every route reads —
 * into an unchecked bag. The four fields the helper actually computes
 * (`hasSession`, `wsHost`, `requireToken`, `wsPort`) are excluded and
 * re-declared below with the shapes the caller supplies.
 */
type WebuiDepsPassthrough = Omit<
  WebuiDeps,
  'hasSession' | 'wsHost' | 'requireToken' | 'wsPort' | 'publicUrl' | 'publicWsUrl'
>;

export interface CreateWebuiDepsParams extends WebuiDepsPassthrough {
  /** Live sockets, used by the derived `hasSession` probe. Not part of deps. */
  clients: Map<WebSocket, ConnectedClient>;
  wsHost?: string | undefined;
  requireToken?: boolean | undefined;
  publicUrl?: string | undefined;
  publicWsUrl?: string | undefined;
}

export function createWebuiDeps(params: CreateWebuiDepsParams): WebuiDeps {
  const { clients, wsHost, requireToken, publicUrl, publicWsUrl, ...passthrough } = params;
  const { agent, peekAgent } = passthrough;

  return {
    ...passthrough,
    hasSession: (id: string) =>
      id === agent.ctx.session?.id ||
      Boolean(peekAgent?.(id)) ||
      [...clients.values()].some((c) => c.sessionId === id || c.sessionIds?.has(id) === true),
    wsHost: wsHost ?? '127.0.0.1',
    requireToken: Boolean(requireToken),
    publicUrl,
    publicWsUrl,
    wsPort: passthrough.httpPort,
  };
}

export function createWebuiCallbacks(params: {
  sessionStartPayload: WebuiCallbacks['sessionStartPayload'];
  sessionIdentity: StandaloneSessionIdentityLifecycle;
  todosCheckpoint: ReturnType<typeof createStandaloneTodosCheckpointLifecycle>;
  /** Only `context` is read here — the freshly built deps are passed whole. */
  deps: Pick<WebuiDeps, 'context'>;
  updateAutoCompactionMaxContext: WebuiCallbacks['updateAutoCompactionMaxContext'];
  updateGlobalConfig: (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  persistPrefsToConfig: (payload: Record<string, unknown>) => Promise<void>;
  prefSnapshot: () => Record<string, unknown>;
}): WebuiCallbacks {
  const {
    sessionStartPayload,
    sessionIdentity,
    todosCheckpoint,
    deps,
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  } = params;

  return {
    sessionStartPayload,
    claimSession: (sessionId, target) => sessionIdentity.claim(sessionId, target),
    onBeforeSessionTodosReplaced: todosCheckpoint.rebind,
    onSessionSwapped: async (sessionId, target) => {
      await sessionIdentity.activate(sessionId, target);
      const { hydrateSessionKanban } = await import('@wrongstack/tools/session-kanban');
      await hydrateSessionKanban(deps.context);
    },
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  };
}
