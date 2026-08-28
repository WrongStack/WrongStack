import type { FleetChatVerbosity } from '@wrongstack/core/types';
import { useEffect, useMemo, useReducer } from 'react';
import {
  buildRestoredCheckpoints,
  buildRestoredEntries,
  createInitialState,
} from '../app-initial-state.js';
import { reducer } from '../app-reducer.js';
import type { AppProps } from '../app-props.js';
import { LayoutStore } from '../layout-store.js';

interface AppSessionStateOptions {
  agent: AppProps['agent'];
  banner: boolean;
  appVersion?: string | undefined;
  provider?: string | undefined;
  model: string;
  family?: string | undefined;
  keyTail?: string | undefined;
  profile?: string | undefined;
  profileConfigPath?: string | undefined;
  autonomyAgents?: AppProps['autonomyAgents'];
  restoredMessages?: AppProps['restoredMessages'];
  restoredToolCalls?: AppProps['restoredToolCalls'];
  restoredEvents?: AppProps['restoredEvents'];
  enhanceEnabled: boolean;
  initialAgentsMonitorOpen?: boolean | undefined;
  initialFleetChat?: FleetChatVerbosity | undefined;
  sessionsDir?: string | undefined;
}

export function useAppSessionState(options: AppSessionStateOptions) {
  const restoredMessageSource = options.restoredMessages ?? options.agent.ctx.messages;
  const restoredEntries = useMemo(
    () =>
      buildRestoredEntries(
        restoredMessageSource,
        options.restoredToolCalls,
        options.restoredEvents,
      ),
    [restoredMessageSource, options.restoredToolCalls, options.restoredEvents],
  );
  const restoredCheckpoints = useMemo(
    () => buildRestoredCheckpoints(options.restoredEvents),
    [options.restoredEvents],
  );
  const initialContextSnapshot = useMemo(() => {
    const lastReq = options.agent?.ctx?.lastRequestTokens;
    const reqTokens = options.agent?.ctx?.tokenCounter?.currentRequestTokens?.();
    const sumReqTokens =
      (typeof reqTokens === 'number' ? reqTokens : 0) +
      (typeof reqTokens?.input === 'number' ? reqTokens.input : 0) +
      (typeof reqTokens?.cacheRead === 'number' ? reqTokens.cacheRead : 0) +
      (typeof reqTokens?.cacheWrite === 'number' ? reqTokens.cacheWrite : 0);
    const tokens = sumReqTokens > 0 ? sumReqTokens : (typeof lastReq === 'number' ? lastReq : 0);
    const maxContext =
      (options.agent?.ctx?.provider as { capabilities?: { maxContext?: number } } | undefined)
        ?.capabilities?.maxContext ?? 0;
    return tokens > 0 ? { tokens, maxContext } : undefined;
  }, [options.agent?.ctx]);

  const [state, dispatch] = useReducer(
    reducer,
    createInitialState({
      banner: options.banner,
      appVersion: options.appVersion,
      provider: options.provider,
      model: options.model,
      cwd: options.agent.ctx.cwd,
      family: options.family,
      keyTail: options.keyTail,
      sessionId: options.agent.ctx.session.id,
      profile: options.profile,
      profileConfigPath: options.profileConfigPath,
      autonomyAgents: options.autonomyAgents,
      restoredEntries,
      restoredCheckpoints,
      initialContextSnapshot,
      enhanceEnabled: options.enhanceEnabled,
      initialAgentsMonitorOpen: options.initialAgentsMonitorOpen,
      initialFleetChat: options.initialFleetChat,
    }),
  );

  const layoutStore = useMemo(
    () =>
      new LayoutStore({
        sessionDataDir: options.sessionsDir,
        ephemeral: !options.sessionsDir,
      }),
    [options.sessionsDir],
  );
  useEffect(() => {
    void layoutStore.load();
    return () => {
      void layoutStore.flushNow();
    };
  }, [layoutStore]);

  return { state, dispatch, layoutStore };
}
