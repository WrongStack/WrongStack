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
  setModeId: (id: string) => void;
  sessionStartPayload: () => Promise<SessionStartPayload>;
}

export function createModeHandlers(context: ModeHandlersContext) {
  return createModeRouteHandlers({
    modeStore: context.modeStore,
    getSession: () => context.context.session,
    applyModeId: context.setModeId,
    send,
    afterSwitch: async (id) => {
      await rebuildSystemPrompt(
        {
          modeStore: context.modeStore,
          memoryStore: context.memoryStore,
          skillLoader: context.skillLoader,
          modelCapabilities: context.modelCapabilities,
          context: context.context,
          toolRegistry: context.toolRegistry,
          getConfig: () => context.getConfig?.() ?? context.config,
          projectRoot: context.projectRoot,
          globalRoot: context.globalRoot,
        },
        id,
      );
      broadcast(context.clients, {
        type: 'session.start',
        payload: { ...(await context.sessionStartPayload()) },
      });
    },
  });
}
