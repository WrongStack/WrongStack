/**
 * Shared Design Studio WebSocket handlers for both the standalone WebUI server
 * (`packages/webui/src/server/index.ts`) and the CLI's `--webui` embedded
 * server (`packages/cli/src/webui-server.ts`). One source of truth keeps the two
 * servers at parity (enforced by ws-handler-parity.test.ts).
 *
 *   case 'design.list':        return handleDesignList(ws, designCtx);
 *   case 'design.use':         return handleDesignUse(ws, designCtx, msg);
 *   case 'design.state':       return handleDesignState(ws, designCtx);
 *   case 'design.set':         return handleDesignSet(ws, designCtx, msg);
 *   case 'design.materialize': return handleDesignMaterialize(ws, designCtx, msg);
 *
 * Browsing + customization of curated UI design kits; `design.use` pins the
 * active kit, `design.set` records color/token overrides, `design.materialize`
 * writes the (override-applied) tokens to a real theme file on disk.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignStack } from '@wrongstack/core';
import {
  applyTokenOverrides,
  getDesignKitLoader,
  getDesignState,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordKitChoice,
  recordOverrides,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { send } from './ws-utils.js';

/** Coerce a loose payload value into a string→string override map. */
function readOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

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
  overrides: Record<string, string>;
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
  const persisted = await loadActiveKit(ctx.projectRoot).catch(() => undefined);
  return {
    kits,
    activeKit: state?.activeKit ?? persisted?.kit ?? null,
    stack: state?.stack ?? persisted?.stack ?? null,
    overrides: state?.overrides ?? persisted?.overrides ?? {},
  };
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
    payload: {
      activeKit: state?.activeKit ?? null,
      stack: state?.stack ?? null,
      overrides: state?.overrides ?? {},
    },
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
    // Preserve persisted overrides for this kit; merge any passed with `use`.
    const persisted = await loadActiveKit(ctx.projectRoot).catch(() => undefined);
    const keep = persisted?.kit === kit.id ? (persisted.overrides ?? {}) : {};
    const overrides = { ...keep, ...readOverrides((payload as { overrides?: unknown }).overrides) };
    if (ctx.agentMeta) setActiveKit(ctx.agentMeta, kit.id, stack, overrides);
    await recordKitChoice(
      ctx.projectRoot,
      kit.id,
      stack,
      'webui',
      new Date().toISOString(),
      Object.keys(overrides).length ? overrides : undefined,
    );
    const body = await loader.readBody(kit.id, stack);
    const rawTokens = await loader.readTokens(kit.id);
    const tokens = rawTokens ? applyTokenOverrides(rawTokens, overrides) : rawTokens;
    send(ws, {
      type: 'design.use',
      payload: {
        ok: true,
        kit: kit.id,
        name: kit.name,
        aesthetic: kit.aesthetic,
        stack,
        body,
        overrides,
        light: tokens?.light ?? {},
        dark: tokens?.dark ?? {},
      },
    });
  } catch (err) {
    send(ws, { type: 'design.use', payload: { ok: false, kit: kitId, error: String(err) } });
  }
}

/** Record structured color/token overrides without changing the pinned kit. */
export async function handleDesignSet(
  ws: WebSocket,
  ctx: DesignContext,
  msg: { payload?: unknown },
): Promise<void> {
  const patch = readOverrides((msg.payload as { overrides?: unknown })?.overrides);
  if (Object.keys(patch).length === 0) {
    send(ws, { type: 'design.set', payload: { ok: false, error: 'No overrides provided' } });
    return;
  }
  try {
    const merged = await recordOverrides(ctx.projectRoot, patch, new Date().toISOString());
    if (!merged) {
      send(ws, { type: 'design.set', payload: { ok: false, error: 'No active kit' } });
      return;
    }
    if (ctx.agentMeta) setDesignOverrides(ctx.agentMeta, merged);
    send(ws, { type: 'design.set', payload: { ok: true, overrides: merged } });
  } catch (err) {
    send(ws, { type: 'design.set', payload: { ok: false, error: String(err) } });
  }
}

/** Write the active kit's (override-applied) tokens to a real theme file. */
export async function handleDesignMaterialize(
  ws: WebSocket,
  ctx: DesignContext,
  msg: { payload?: unknown },
): Promise<void> {
  const payload = (msg.payload ?? {}) as { stack?: unknown; out?: unknown };
  try {
    const active = await loadActiveKit(ctx.projectRoot);
    if (!active) {
      send(ws, { type: 'design.materialize', payload: { ok: false, error: 'No active kit' } });
      return;
    }
    const loader = getDesignKitLoader(ctx.projectRoot);
    const stackArg = typeof payload.stack === 'string' ? payload.stack : undefined;
    const stack: DesignStack =
      stackArg && isDesignStack(stackArg)
        ? stackArg
        : active.stack && isDesignStack(active.stack)
          ? active.stack
          : 'web';
    const raw = await loader.readTokens(active.kit);
    if (!raw) {
      send(ws, { type: 'design.materialize', payload: { ok: false, error: 'Kit has no tokens' } });
      return;
    }
    const tokens = applyTokenOverrides(raw, active.overrides);
    const result = materializeTokens({
      tokens,
      stack,
      kitId: active.kit,
      outPath: typeof payload.out === 'string' ? payload.out : undefined,
    });
    const abs = path.join(ctx.projectRoot, result.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, result.content);
    send(ws, {
      type: 'design.materialize',
      payload: { ok: true, path: result.path, format: result.format, stack },
    });
  } catch (err) {
    send(ws, { type: 'design.materialize', payload: { ok: false, error: String(err) } });
  }
}
