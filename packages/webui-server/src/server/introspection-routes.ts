import type { Agent } from '@wrongstack/core/agent';
import type { Config, ConfigStore, ModelsRegistry } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { resolveProviderModelMetadata } from './model-catalog.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';

export interface IntrospectionRouteContext {
  agent: Agent;
  modelsRegistry?: ModelsRegistry | undefined;
  configStore?: ConfigStore | undefined;
  getConfig: () => Config;
  getProjectRoot: () => string;
  getSessionId: () => string;
  getSessionStartedAt: () => number;
  getModeId: () => string;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  allowSessionMessage?: ((ws: WebSocket, message: WSClientMessage) => boolean) | undefined;
}

interface ToolLike {
  name: string;
  description?: string | undefined;
  inputSchema?: { properties?: Record<string, unknown> } | undefined;
  mutating?: boolean | undefined;
  permission?: string | undefined;
}

interface ToolEntryLike {
  tool: ToolLike;
  owner: string;
}

function toolEntries(ctx: IntrospectionRouteContext): ToolEntryLike[] {
  const registry = ctx.agent.tools as unknown as {
    list?: () => ToolLike[];
    listWithOwner?: () => ToolEntryLike[];
    listDisabled?: () => ToolEntryLike[];
  };
  if (typeof registry.listWithOwner === 'function') {
    return [
      ...registry.listWithOwner(),
      ...(typeof registry.listDisabled === 'function' ? registry.listDisabled() : []),
    ];
  }
  return (registry.list?.() ?? []).map((tool) => ({ tool, owner: 'core' }));
}

function persistDisabledTool(
  ctx: IntrospectionRouteContext,
  name: string,
  disabled: boolean,
): void {
  if (!ctx.configStore) return;
  const currentTools = ctx.configStore.get().tools ?? {};
  const disabledTools = new Set(currentTools.disabledTools ?? []);
  if (disabled) disabledTools.add(name);
  else disabledTools.delete(name);
  ctx.configStore.update({ tools: { ...currentTools, disabledTools: [...disabledTools] } });
}

function toolName(payload: unknown): string | undefined {
  const value = (payload as { name?: unknown } | undefined)?.name;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sessionAllowed(
  ctx: IntrospectionRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): boolean {
  return ctx.allowSessionMessage?.(ws, message) ?? true;
}

/** Canonical diagnostics/tool-registry handler shared by every WebUI host. */
export async function handleIntrospectionRoute(
  ctx: IntrospectionRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  const actx = ctx.agent.ctx;
  const config = ctx.getConfig();
  switch (message.type) {
    case 'diag.get': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      const tools = ctx.agent.tools.list();
      ctx.send(ws, {
        type: 'diag.get',
        payload: {
          provider: actx.provider.id,
          model: actx.model,
          cwd: ctx.getProjectRoot(),
          sessionId: ctx.getSessionId(),
          tools: { count: tools.length, names: tools.map((tool) => tool.name) },
          maxTools: (actx.provider as { maxToolsCount?: number }).maxToolsCount ?? 0,
          droppedTools: (() => {
            const mt = (actx.provider as { maxToolsCount?: number }).maxToolsCount ?? 0;
            return mt > 0 ? Math.max(0, tools.length - mt) : 0;
          })(),
          features: {
            memory: !!config.features?.memory,
            skills: !!config.features?.skills,
            modelsRegistry: !!config.features?.modelsRegistry,
          },
          mode: ctx.getModeId() || 'default',
          usage: actx.tokenCounter.total(),
          messages: actx.messages.length,
          todos: actx.todos.length,
        },
      });
      return true;
    }
    case 'stats.get': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      const usage = actx.tokenCounter.total();
      const cache = actx.tokenCounter.cacheStats();
      const metadata = ctx.modelsRegistry
        ? await resolveProviderModelMetadata(
            ctx.modelsRegistry,
            actx.provider.id,
            actx.model,
            config.providers?.[actx.provider.id],
          ).catch(() => null)
        : null;
      ctx.send(ws, {
        type: 'stats.get',
        payload: {
          sessionId: ctx.getSessionId(),
          provider: actx.provider.id,
          model: actx.model,
          usage,
          cache,
          cost: metadata ? computeUsageCost(usage, getCostRates(metadata)) : null,
          messages: actx.messages.length,
          readFiles: actx.readFiles.size,
          tools: ctx.agent.tools.list().length,
          sideEffectCount: actx.sideEffects?.length ?? 0,
          elapsedMs: Date.now() - ctx.getSessionStartedAt(),
        },
      });
      return true;
    }
    case 'side_effects.list': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      ctx.send(ws, {
        type: 'side_effects',
        payload: {
          sessionId: ctx.getSessionId(),
          sideEffects: (actx.sideEffects ?? []).slice(-50).map((effect) => ({
            toolUseId: effect.toolUseId,
            toolName: effect.toolName,
            ts: effect.ts,
            input: effect.input,
            outcome: effect.outcome,
            risk: effect.risk,
          })),
        },
      });
      return true;
    }
    case 'tools.list': {
      const registry = ctx.agent.tools as unknown as { isDisabled?: (name: string) => boolean };
      const tools = toolEntries(ctx).map(({ tool, owner }) => {
        const schema = tool.inputSchema ?? {};
        return {
          name: tool.name,
          owner,
          description: tool.description ?? '',
          params: schema.properties ? Object.keys(schema.properties) : [],
          disabled: registry.isDisabled?.(tool.name) ?? false,
          mutating: !!tool.mutating,
          permission: tool.permission ?? 'auto',
        };
      });
      ctx.send(ws, { type: 'tools.list', payload: { tools } });
      return true;
    }
    case 'tool.disable':
    case 'tool.enable': {
      const name = toolName(message.payload);
      if (!name) {
        ctx.send(ws, {
          type: 'error',
          payload: { message: `${message.type} requires a name` },
        });
        return true;
      }
      const disabled = message.type === 'tool.disable';
      const ok = disabled ? ctx.agent.tools.disable(name) : ctx.agent.tools.enable(name);
      if (ok) persistDisabledTool(ctx, name, disabled);
      ctx.send(ws, {
        type: disabled ? 'tool.disabled' : 'tool.enabled',
        payload: { name, ok },
      });
      return true;
    }
    default:
      return false;
  }
}
