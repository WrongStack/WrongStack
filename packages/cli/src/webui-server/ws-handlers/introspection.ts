import type { Agent, ModelsRegistry, SkillLoader } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { computeUsageCost, getCostRates } from '../cost-helpers.js';
import type { WsCommon } from './index.js';

/**
 * PR 5c of Issue #30: read-only introspection WebSocket handlers
 * (`skills.list`, `tools.list`, `diag.get`, `stats.get`).
 *
 * These four cases all snapshot live run state (the agent context, the
 * tool registry, the skill loader, token usage) and send it to the
 * browser — none mutate anything. Extracted from the runWebUI switch onto
 * an `IntrospectionContext`: a read-only view of the run.
 */

export interface IntrospectionContext extends WsCommon {
  /** The running agent — read for ctx (provider/model/usage/messages/…) and tools. */
  agent: Agent;
  /** Skill loader backing skills.list (optional — absent ⇒ feature disabled). */
  skillLoader: SkillLoader | undefined;
  /** Models registry, used by stats.get to price token usage (optional). */
  modelsRegistry: ModelsRegistry | undefined;
  /** Project root reported by diag.get (falls back to ctx.projectRoot). */
  projectRoot: string | undefined;
  /** Active session id. */
  sessionId: string;
  /** Epoch ms when the run started — stats.get reports elapsed time. */
  sessionStartedAt: number;
}

export async function handleSkillsList(ctx: IntrospectionContext, ws: WebSocket): Promise<void> {
  if (!ctx.skillLoader) {
    ctx.send(ws, { type: 'skills.list', payload: { skills: [], enabled: false } });
    return;
  }
  try {
    const manifests = await ctx.skillLoader.list();
    const entries = await ctx.skillLoader.listEntries();
    const byName = new Map(entries.map((e) => [e.name, e]));
    ctx.send(ws, {
      type: 'skills.list',
      payload: {
        enabled: true,
        skills: manifests.map((m) => ({
          name: m.name,
          description: m.description,
          version: m.version ?? '',
          source: m.source,
          path: m.path,
          trigger: byName.get(m.name)?.trigger ?? '',
          scope: byName.get(m.name)?.scope ?? [],
        })),
      },
    });
  } catch (err) {
    ctx.send(ws, {
      type: 'skills.list',
      payload: {
        skills: [],
        enabled: true,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function handleToolsList(ctx: IntrospectionContext, ws: WebSocket): void {
  const list = ctx.agent.tools.list().map((t) => {
    const schema =
      (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema ?? {};
    const params = schema.properties ? Object.keys(schema.properties) : [];
    return {
      name: t.name,
      description: (t as { description?: string | undefined }).description ?? '',
      params,
    };
  });
  ctx.send(ws, { type: 'tools.list', payload: { tools: list } });
}

export function handleDiagGet(ctx: IntrospectionContext, ws: WebSocket): void {
  // Snapshot of key metrics — mirrors the standalone server's handler
  // and the CLI /diag output. Uses the agent context for live state.
  const actx = ctx.agent.ctx;
  const tools = ctx.agent.tools.list();
  ctx.send(ws, {
    type: 'diag.get',
    payload: {
      provider: (actx.provider as { id: string }).id,
      model: actx.model,
      cwd: ctx.projectRoot ?? actx.projectRoot,
      sessionId: ctx.sessionId,
      tools: {
        count: tools.length,
        names: tools.map((t) => t.name),
      },
      features: {},
      mode: 'default',
      usage: actx.tokenCounter.total(),
      messages: actx.messages.length,
      todos: actx.todos.length,
    },
  });
}

export async function handleStatsGet(ctx: IntrospectionContext, ws: WebSocket): Promise<void> {
  // Detailed session usage stats, mirroring the CLI /stats.
  const actx = ctx.agent.ctx;
  const usage = actx.tokenCounter.total();
  const cacheStats = actx.tokenCounter.cacheStats();
  let cost: number | null = null;
  try {
    if (ctx.modelsRegistry) {
      const model = await ctx.modelsRegistry.getModel(
        (actx.provider as { id: string }).id,
        actx.model,
      );
      const rates = getCostRates(model);
      cost = computeUsageCost(
        { input: usage.input, output: usage.output, cacheRead: cacheStats.readTokens },
        rates,
      );
    }
  } catch {
    /* cost stays null */
  }
  ctx.send(ws, {
    type: 'stats.get',
    payload: {
      sessionId: ctx.sessionId,
      provider: (actx.provider as { id: string }).id,
      model: actx.model,
      usage,
      cache: cacheStats,
      cost,
      messages: actx.messages.length,
      readFiles: actx.readFiles.size,
      tools: ctx.agent.tools.list().length,
      elapsedMs: Date.now() - ctx.sessionStartedAt,
    },
  });
}
