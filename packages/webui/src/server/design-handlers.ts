/**
 * Shared Design Studio WebSocket handlers for both the standalone WebUI server
 * (`packages/webui/src/server/index.ts`) and the CLI's `--webui` embedded
 * server (`packages/cli/src/webui-server.ts`). One source of truth keeps the two
 * servers at parity (enforced by ws-handler-parity.test.ts).
 *
 *   case 'design.list':  return handleDesignList(ws, designCtx);
 *   case 'design.use':   return handleDesignUse(ws, designCtx, msg);
 *   case 'design.state': return handleDesignState(ws, designCtx);
 *
 * Read-only browsing of curated UI design kits; `design.use` pins the active
 * kit on the live agent context (so the per-turn injector switches to the
 * adherence reminder) and returns the loaded spec + tokens for preview.
 */

import type { DesignStack } from '@wrongstack/core';
import {
  getDesignKitLoader,
  getDesignState,
  isDesignStack,
  recordKitChoice,
  setActiveKit,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { send } from './ws-utils.js';

export interface DesignContext {
  projectRoot: string;
  /** Live agent context whose `meta.designStudio` we read/pin. Optional. */
  agentMeta?: { meta: Record<string, unknown> } | undefined;
}

const FOUNDATIONS_ID = '_foundations';

async function buildListPayload(ctx: DesignContext): Promise<{
  kits: Array<{
    id: string;
    name: string;
    aesthetic: string;
    bestFor: string;
    stacks: string[];
    tags: string[];
    light: Record<string, string>;
    dark: Record<string, string>;
  }>;
  activeKit: string | null;
  stack: string | null;
}> {
  const loader = getDesignKitLoader(ctx.projectRoot);
  const manifests = (await loader.list()).filter((k) => k.id !== FOUNDATIONS_ID);
  const kits = [];
  for (const m of manifests) {
    const tokens = await loader.readTokens(m.id);
    kits.push({
      id: m.id,
      name: m.name,
      aesthetic: m.aesthetic,
      bestFor: m.bestFor,
      stacks: m.stacks,
      tags: m.tags,
      light: tokens?.light ?? {},
      dark: tokens?.dark ?? {},
    });
  }
  const state = ctx.agentMeta ? getDesignState(ctx.agentMeta) : undefined;
  return { kits, activeKit: state?.activeKit ?? null, stack: state?.stack ?? null };
}

export async function handleDesignList(ws: WebSocket, ctx: DesignContext): Promise<void> {
  try {
    send(ws, { type: 'design.list', payload: await buildListPayload(ctx) });
  } catch (err) {
    send(ws, {
      type: 'design.list',
      payload: { kits: [], activeKit: null, stack: null, error: String(err) },
    });
  }
}

export async function handleDesignState(ws: WebSocket, ctx: DesignContext): Promise<void> {
  const state = ctx.agentMeta ? getDesignState(ctx.agentMeta) : undefined;
  send(ws, {
    type: 'design.state',
    payload: { activeKit: state?.activeKit ?? null, stack: state?.stack ?? null },
  });
}

export async function handleDesignUse(
  ws: WebSocket,
  ctx: DesignContext,
  msg: { payload?: unknown },
): Promise<void> {
  const payload = (msg.payload ?? {}) as { kit?: unknown; stack?: unknown };
  const kitId = typeof payload.kit === 'string' ? payload.kit.trim() : '';
  if (!kitId) {
    send(ws, { type: 'design.use', payload: { ok: false, error: 'No kit id provided' } });
    return;
  }
  try {
    const loader = getDesignKitLoader(ctx.projectRoot);
    const kit = await loader.find(kitId);
    if (!kit) {
      send(ws, { type: 'design.use', payload: { ok: false, kit: kitId, error: 'Kit not found' } });
      return;
    }
    const stackArg = typeof payload.stack === 'string' ? payload.stack : undefined;
    const stack: DesignStack =
      stackArg && isDesignStack(stackArg) ? stackArg : (kit.stacks[0] ?? 'web');
    if (ctx.agentMeta) setActiveKit(ctx.agentMeta, kit.id, stack);
    await recordKitChoice(ctx.projectRoot, kit.id, stack, 'webui', new Date().toISOString());
    const body = await loader.readBody(kit.id, stack);
    const tokens = await loader.readTokens(kit.id);
    send(ws, {
      type: 'design.use',
      payload: {
        ok: true,
        kit: kit.id,
        name: kit.name,
        aesthetic: kit.aesthetic,
        stack,
        body,
        light: tokens?.light ?? {},
        dark: tokens?.dark ?? {},
      },
    });
  } catch (err) {
    send(ws, { type: 'design.use', payload: { ok: false, kit: kitId, error: String(err) } });
  }
}
