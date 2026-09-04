import type { Agent } from '@wrongstack/core/agent';
import type { Config, ConfigStore, ModelsRegistry } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { resolveProviderModelMetadata } from './model-catalog.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import { messageSessionId, withRequestId } from './ws-utils.js';

export interface IntrospectionRouteContext {
  /** The runtime's agent — the fallback when the host has no registry. */
  agent: Agent;
  /**
   * Resolve the agent that owns ONE session.
   *
   * `diag.get`, `stats.get` and `side_effects.list` describe a single
   * conversation: its token counter, its message count, its side effects. The
   * runtime's `agent` is the session it last SWITCHED to, which with four tabs
   * open is a different tab from the asking one as often as not — so a
   * background tab asking for its stats was answered with the foreground's
   * numbers, stamped with the foreground's id (and then dropped by the
   * browser's own session filter, leaving the panel blank).
   *
   * Hosts with a per-session agent registry pass this; single-session hosts
   * omit it and keep exactly their old behaviour.
   */
  getAgent?: ((sessionId?: string) => Agent | undefined) | undefined;
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
    listForProvider?: () => ToolLike[];
    listWithOwner?: () => ToolEntryLike[];
    listDisabled?: () => ToolEntryLike[];
    isExposedToProvider?: (name: string) => boolean;
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
  // The agent this request is ABOUT — the one the tab named, not the one the
  // runtime happens to be sitting on. Resolved without calling
  // `getSessionId()`: this function also sees message types it does not
  // handle, and must not require host accessors to answer them.
  const agent = ctx.getAgent?.(messageSessionId(message)) ?? ctx.agent;
  const actx = agent.ctx;
  const config = ctx.getConfig();
  /** The id to stamp a reply with — the asking tab's, falling back to the runtime's. */
  const askingSessionId = (): string => messageSessionId(message) ?? ctx.getSessionId();
  /**
   * When the asking session is not the runtime's, `getSessionStartedAt()`
   * measures the wrong conversation; the session's own metadata is the only
   * per-session clock available here.
   */
  const startedAt = (): number => {
    if (askingSessionId() === ctx.getSessionId()) return ctx.getSessionStartedAt();
    const iso = (actx.session as { startedAt?: string } | undefined)?.startedAt;
    const parsed = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : ctx.getSessionStartedAt();
  };
  switch (message.type) {
    case 'diag.get': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      const registry = agent.tools as unknown as {
        list: () => ToolLike[];
        listForProvider?: () => ToolLike[];
      };
      const tools = registry.listForProvider?.() ?? registry.list();
      ctx.send(ws, {
        type: 'diag.get',
        payload: withRequestId(message.payload, {
          provider: actx.provider.id,
          model: actx.model,
          cwd: ctx.getProjectRoot(),
          sessionId: askingSessionId(),
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
        }),
      });
      return true;
    }
    case 'stats.get': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      const usage =
        typeof actx.tokenCounter?.total === 'function'
          ? actx.tokenCounter.total()
          : { input: 0, output: 0, total: 0 };
      const cache =
        typeof actx.tokenCounter?.cacheStats === 'function'
          ? actx.tokenCounter.cacheStats()
          : { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 };
      const currentRequest =
        typeof actx.tokenCounter?.currentRequestTokens === 'function'
          ? actx.tokenCounter.currentRequestTokens()
          : 0;
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
        payload: withRequestId(message.payload, {
          sessionId: askingSessionId(),
          provider: actx.provider.id,
          model: actx.model,
          usage,
          cache,
          // Per-request token snapshot — `usage.cacheRead` above is
          // cumulative and would mislead the "cache covers the first N
          // tokens of THIS prompt" indicator. `currentRequest.cacheRead`
          // is the cached prefix of the most recent request only.
          currentRequest,
          cost: metadata ? computeUsageCost(usage, getCostRates(metadata)) : null,
          messages: actx.messages.length,
          readFiles: actx.readFiles.size,
          tools: agent.tools.list().length,
          sideEffectCount: actx.sideEffects?.length ?? 0,
          elapsedMs: Date.now() - startedAt(),
        }),
      });
      return true;
    }
    case 'side_effects.list': {
      if (!sessionAllowed(ctx, ws, message)) return true;
      ctx.send(ws, {
        type: 'side_effects',
        payload: {
          sessionId: askingSessionId(),
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
      const registry = ctx.agent.tools as unknown as {
        isDisabled?: (name: string) => boolean;
        isExposedToProvider?: (name: string) => boolean;
      };
      const tools = toolEntries(ctx).map(({ tool, owner }) => {
        const schema = tool.inputSchema ?? {};
        return {
          name: tool.name,
          owner,
          description: tool.description ?? '',
          params: schema.properties ? Object.keys(schema.properties) : [],
          disabled: registry.isDisabled?.(tool.name) ?? false,
          direct: registry.isExposedToProvider?.(tool.name) ?? true,
          mutating: !!tool.mutating,
          permission: tool.permission ?? 'auto',
        };
      });
      ctx.send(ws, { type: 'tools.list', payload: withRequestId(message.payload, { tools }) });
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
