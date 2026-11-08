import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/contracts/types';
import type { AppUpdateInfo } from './app-update-check.js';
import type { WebuiMutableState } from './routes.js';
import { createSessionStartPayload } from './server-runtime.js';

/** The per-session context shape `createSessionStartPayload` reads. */
type SessionStartContext =
  NonNullable<Parameters<typeof createSessionStartPayload>[0]['getSessionContext']> extends (
    sessionId: string,
  ) => infer R
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
  peekAgent?: ((sessionId: string) => { ctx?: SessionStartContext } | undefined) | undefined;
  /** The host's version and the newest release, when the host checks for one. */
  getAppUpdate?: (() => AppUpdateInfo) | undefined;
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
    getAppUpdate,
  } = params;

  const build = createSessionStartPayload({
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
  if (!getAppUpdate) return build;
  // The same fields the CLI hands its WebUI: the WebUI's update banner and the desktop read them.
  return (async (...args: Parameters<typeof build>) => ({
    ...(await build(...args)),
    ...getAppUpdate(),
  })) as typeof build;
}
