/**
 * Mode route handlers — extracted from the startWebUI closure in index.ts.
 * Mirrors createProviderHandlers: a factory that closes the handler bodies over
 * an explicit context object instead of the giant startWebUI scope. The one
 * piece of outer mutable state (the `modeId` let) is threaded in as a setter so
 * the factory stays a pure function of its context.
 */
import type { WebSocket } from 'ws';
import {
  type Context,
  DefaultSystemPromptBuilder,
  type DefaultMemoryStore,
  type DefaultModeStore,
  type SkillLoader,
  type ToolRegistry,
} from '@wrongstack/core';
import type { ConnectedClient } from './types.js';
import type { ModeRouteHandlers } from './mode-routes.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';
import { validateModeSwitchPayload } from './ws-payload-validation.js';

/** The rich payload startWebUI's sessionStartPayload() resolves to. Matches the
 *  WSSessionStart wire shape; broadcast() accepts it for a 'session.start' msg. */
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
  memoryStore: DefaultMemoryStore;
  skillLoader: SkillLoader | undefined;
  modelCapabilities: ModelCapabilities;
  context: Context;
  toolRegistry: ToolRegistry;
  config: { provider: string; model: string };
  projectRoot: string;
  clients: Map<WebSocket, ConnectedClient>;
  /** Update the outer `modeId` binding on a successful switch. */
  setModeId: (id: string) => void;
  /** Rebuilds the rich session.start payload broadcast after a mode switch. */
  sessionStartPayload: () => Promise<SessionStartPayload>;
}

export function createModeHandlers(ctx: ModeHandlersContext): ModeRouteHandlers {
  return {
    listModes: async (ws) => {
      try {
        const modes = await ctx.modeStore.listModes();
        const active = await ctx.modeStore.getActiveMode();
        send(ws, {
          type: 'modes.list',
          payload: {
            modes: modes.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              isActive: m.id === (active?.id ?? 'default'),
            })),
            activeId: active?.id ?? 'default',
          },
        });
      } catch (err) {
        send(ws, {
          type: 'modes.list',
          payload: {
            modes: [],
            activeId: 'default',
            error: errMessage(err),
          },
        });
      }
    },
    switchMode: async (ws, msg) => {
      const parsed = validateModeSwitchPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      try {
        if (id === 'default') {
          await ctx.modeStore.setActiveMode(null);
        } else {
          const found = await ctx.modeStore.getMode(id);
          if (!found) throw new Error(`Unknown mode "${id}"`);
          await ctx.modeStore.setActiveMode(id);
        }
        ctx.setModeId(id);
        const modePrompt = id === 'default' ? '' : ((await ctx.modeStore.getMode(id))?.prompt ?? '');
        const freshBuilder = new DefaultSystemPromptBuilder({
          memoryStore: ctx.memoryStore,
          skillLoader: ctx.skillLoader,
          modeStore: ctx.modeStore,
          modeId: id,
          modePrompt,
          modelCapabilities: ctx.modelCapabilities,
        });
        ctx.context.systemPrompt = await freshBuilder.build({
          cwd: ctx.projectRoot,
          projectRoot: ctx.projectRoot,
          tools: ctx.toolRegistry.list(),
          provider: ctx.config.provider,
          model: ctx.config.model,
        });
        sendResult(ws, true, `Switched to mode "${id}"`);
        broadcast(ctx.clients, {
          type: 'session.start',
          payload: { ...(await ctx.sessionStartPayload()) },
        });
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
  };
}
