import type { ModelsRegistry } from '@wrongstack/core/types';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import type { WebuiMutableState } from './routes.js';
import { createSessionStartPayload } from './server-runtime.js';

export function createStartWebuiSessionPayloadHelper(params: {
  getConfig: () => any;
  getSessionId: () => string;
  getProjectRoot: () => string;
  getWorkingDir: () => string;
  getModeId: () => string;
  getContextMeta: () => Record<string, unknown>;
  needsSetup: boolean;
  stateGetter: () => WebuiMutableState;
  modelsRegistry: ModelsRegistry;
  peekAgent?: ((sessionId: string) => { ctx?: any } | undefined) | undefined;
}) {
  const {
    getConfig,
    getSessionId,
    getProjectRoot,
    getWorkingDir,
    getModeId,
    getContextMeta,
    needsSetup,
    stateGetter,
    modelsRegistry,
    peekAgent,
  } = params;

  return createSessionStartPayload({
    getConfig,
    getSessionId,
    getProjectRoot,
    getWorkingDir,
    getModeId,
    getContextMode: () =>
      String(getContextMeta()['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
    getNeedsSetup: () =>
      needsSetup && !(stateGetter().getConfig().provider && stateGetter().getConfig().model),
    modelsRegistry,
    getSessionContext: (sessionId: string) => peekAgent?.(sessionId)?.ctx,
  });
}
