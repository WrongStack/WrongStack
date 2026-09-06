import type { Config, SessionStore } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { ConfigWriteLockHolder } from './pref-helpers.js';
import type { WebuiMutableState } from './routes.js';
import type { ConnectedClient } from './types.js';

type Session = Awaited<ReturnType<SessionStore['create']>>;

export function createWebuiMutableState(params: {
  getConfig: () => Config;
  setConfig: (c: Config) => void;
  getProjectRoot: () => string;
  setProjectRoot: (r: string) => void;
  getWorkingDir: () => string;
  setWorkingDir: (w: string) => void;
  getSession: () => Session;
  setSession: (s: Session) => void;
  getSessionStartedAt: () => number;
  setSessionStartedAt: (t: number) => void;
  getSessionStore: () => SessionStore;
  setSessionStore: (store: SessionStore) => void;
  getModeId: () => string;
  setModeId: (id: string) => void;
  /** Mirrors `WebuiMutableState.getModelCapabilities()`, which is deliberately
   *  opaque to the route layer. */
  modelCapabilitiesRef: { current: ReturnType<WebuiMutableState['getModelCapabilities']> };
  configWriteLock: ConfigWriteLockHolder;
  runLockControl: {
    abortRunLock: (sessionId?: string) => void;
    hasAny: () => boolean;
  };
  sessionRunLocks: Map<string, AbortController>;
  sessionTransitionGate: <T>(fn: () => Promise<T>) => Promise<T>;
  clients: Map<WebSocket, ConnectedClient>;
}): WebuiMutableState {
  const {
    getConfig,
    setConfig,
    getProjectRoot,
    setProjectRoot,
    getWorkingDir,
    setWorkingDir,
    getSession,
    setSession,
    getSessionStartedAt,
    setSessionStartedAt,
    getSessionStore,
    setSessionStore,
    getModeId,
    setModeId,
    modelCapabilitiesRef,
    configWriteLock,
    runLockControl,
    sessionRunLocks,
    sessionTransitionGate,
    clients,
  } = params;

  return {
    getConfig,
    setConfig,
    getProjectRoot,
    setProjectRoot,
    getWorkingDir,
    setWorkingDir,
    getSession,
    setSession,
    getSessionStartedAt,
    setSessionStartedAt,
    getSessionStore,
    setSessionStore,
    getModeId,
    setModeId,
    getModelCapabilities: () => modelCapabilitiesRef.current,
    getConfigWriteLock: () => configWriteLock.lock,
    setConfigWriteLock: (next) => {
      configWriteLock.lock = next;
    },
    abortRunLock: (sessionId?: string) => runLockControl.abortRunLock(sessionId),
    isRunActive: (sessionId?: string) =>
      sessionId ? sessionRunLocks.has(sessionId) : runLockControl.hasAny(),
    getRunningSessionIds: () => [...sessionRunLocks.keys()],
    withSessionTransition: sessionTransitionGate,
    getClients: () => clients,
  };
}
