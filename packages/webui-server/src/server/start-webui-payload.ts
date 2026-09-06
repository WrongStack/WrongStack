import type { Config, ModelsRegistry } from '@wrongstack/core/types';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import type { WebuiMutableState } from './routes.js';
import { createSessionStartPayload } from './server-runtime.js';

/** The per-session context shape `createSessionStartPayload` reads. */
type SessionStartContext = NonNullable<
  Parameters<typeof createSessionStartPayload>[0]['getSessionContext']
> extends (sessionId: string) => infer R
  ? NonNullable<R>
  : never;

export function createStartWebuiSessionPayloadHelper(params: {
  getConfig: () => Config;
  getSessionId: () => string;
  getProjectRoot: () => string;
  getWorkingDir: () => string;
  getModeId: () => string;
  getContextMeta: () => Record<string, unknown>;
  needsSetup: boolean;
  stateGetter: () => WebuiMutableState;
  modelsRegistry: ModelsRegistry;
  /**
   * Read-only agent lookup. Only `ctx` is touched (it becomes the payload's
   * per-session context), so the parameter is typed by what the payload
   * builder accepts rather than by the full Agent surface.
   */
  peekAgent?:
    | ((sessionId: string) => { ctx?: SessionStartContext } | undefined)
    | undefined;
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
