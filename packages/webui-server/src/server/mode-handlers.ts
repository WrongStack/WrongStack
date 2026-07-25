import { type Context, DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, MemoryPort, SkillLoader } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { createModeRouteHandlers } from './mode-routes.js';
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
  config: Pick<Config, 'provider' | 'model' | 'systemPrompt'>;
  getConfig?: () => Pick<Config, 'provider' | 'model' | 'systemPrompt'>;
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
      const modePrompt =
        id === 'default' ? '' : ((await context.modeStore.getMode(id))?.prompt ?? '');
      const paths = resolveWstackPaths({
        projectRoot: context.projectRoot,
        globalRoot: context.globalRoot,
      });
      const config = context.getConfig?.() ?? context.config;
      const builder = new DefaultSystemPromptBuilder({
        memoryStore: context.memoryStore,
        injectMemory: false,
        skillLoader: context.skillLoader,
        modeStore: context.modeStore,
        modeId: id,
        modePrompt,
        modelCapabilities: context.modelCapabilities,
        instructionPaths: {
          globalDir: paths.globalInstructions,
          projectDir: paths.inProjectInstructions,
          systemVariant: config.systemPrompt?.variant,
        },
      });
      context.context.systemPrompt = await builder.build({
        cwd: context.projectRoot,
        projectRoot: context.projectRoot,
        tools: context.toolRegistry.list(),
        provider: config.provider,
        model: config.model,
      });
      broadcast(context.clients, {
        type: 'session.start',
        payload: { ...(await context.sessionStartPayload()) },
      });
    },
  });
}
