import type { Context, DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, MemoryPort, SkillLoader } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { createModeRouteHandlers } from './mode-routes.js';
import { rebuildSystemPrompt } from './system-prompt-rebuild.js';
import type { ConnectedClient } from './types.js';
import { broadcast, send } from './ws-utils.js';

type SessionStartPayload = {
  sessionId: string;
  model: string;
  provider: string;
  maxContext: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  projectName: string;
  projectRoot: string;
  cwd: string;
  mode: string;
  contextMode: string;
};
type ModelCapabilities = NonNullable<
  ConstructorParameters<typeof DefaultSystemPromptBuilder>[0]
>['modelCapabilities'];

export interface ModeHandlersContext {
  modeStore: DefaultModeStore;
  memoryStore: MemoryPort;
  skillLoader: SkillLoader | undefined;
  modelCapabilities: ModelCapabilities;
  context: Context;
  toolRegistry: ToolRegistry;
  config: Pick<Config, 'provider' | 'model' | 'systemPrompt' | 'features'>;
  getConfig?: () => Pick<Config, 'provider' | 'model' | 'systemPrompt' | 'features'>;
  projectRoot: string;
  globalRoot: string;
  clients: Map<WebSocket, ConnectedClient>;
  setModeId: (id: string, sessionId?: string) => void;
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<SessionStartPayload>;
  /** Resolve a session's own Context so the rebuild targets the right tab. */
  getSessionContext?: ((sessionId?: string) => Context | undefined) | undefined;
}

export function createModeHandlers(context: ModeHandlersContext) {
  return createModeRouteHandlers({
    modeStore: context.modeStore,
    getSession: () => context.context.session,
    applyModeId: context.setModeId,
    send,
    afterSwitch: async (id, sessionId) => {
      // Rebuild the prompt of the TAB that switched. `context.context` is the
      // root context: with four sessions live it belongs to whichever tab the
      // runtime happens to be pointing at, so rebuilding it here would swap a
      // different conversation's system prompt.
      const targetCtx = context.getSessionContext?.(sessionId) ?? context.context;
      // Stamp the mode on that session so its own `session.start` — and any
      // later one — reports the mode this tab is actually running.
      targetCtx.meta['modeId'] = id;
      await rebuildSystemPrompt(
        {
          modeStore: context.modeStore,
          memoryStore: context.memoryStore,
          skillLoader: context.skillLoader,
          modelCapabilities: context.modelCapabilities,
          context: targetCtx,
          toolRegistry: context.toolRegistry,
          getConfig: () => context.getConfig?.() ?? context.config,
          projectRoot: context.projectRoot,
          globalRoot: context.globalRoot,
        },
        id,
      );
      broadcast(context.clients, {
        type: 'session.start',
        payload: {
          ...(await context.sessionStartPayload(sessionId ? { sessionId } : undefined)),
        },
      });
    },
  });
}
