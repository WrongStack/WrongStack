/**
 * Which tools a conversation can actually call — the one answer every
 * consumer reads.
 *
 * `ctx.tools` is the surface sent to the provider (resolved per conversation
 * from its identity variant and tier). `ctx.catalogTools` is everything
 * registered. A tool outside the surface is still reachable when, and only
 * when, the surface carries `tool_use`, the gateway that calls withheld tools.
 * So:
 *
 * - Scout and the token-saving tiers send `tool_use`: the whole catalog is
 *   reachable, most of it through the gateway.
 * - Quick sends a fixed basic set plus the two gateway schemas: the catalog is
 *   reachable on demand without its schemas entering the context.
 * - A surface without `tool_use` (a host that pins one) reaches exactly itself.
 * - A context with no declared surface (`ctx.tools` empty) is unrestricted.
 *
 * The executor enforces this, the unknown-tool message lists it, and the tool
 * coach and the WrongForge gateway offer from it. Before it existed each of
 * them read the registry directly and could disagree about what a session
 * was able to call.
 */

import type { Tool } from '@wrongstack/contracts/types/tool';
import { isSessionToolAllowed } from './session-tool-groups.js';

/** The tool that calls withheld catalog tools; its presence opens the catalog. */
export const CATALOG_GATEWAY_TOOL = 'tool_use';

interface ToolReachContext {
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  readonly projectRoot?: string | undefined;
  readonly currentKanbanBoardId?: string | undefined;
  readonly eventSessionId?: (() => string) | undefined;
  readonly tools?: readonly Tool[] | undefined;
  readonly catalogTools?: readonly Tool[] | undefined;
}

/** The declared surface; anything but an array declares none. */
function surfaceOf(ctx: ToolReachContext): readonly Tool[] {
  return Array.isArray(ctx.tools) ? ctx.tools : [];
}

/** True when this conversation can reach tools beyond its direct surface. */
export function reachesCatalog(ctx: ToolReachContext): boolean {
  const surface = surfaceOf(ctx);
  return surface.length === 0 || surface.some((tool) => tool.name === CATALOG_GATEWAY_TOOL);
}

/** Every tool this conversation can call, directly or through `tool_use`. */
export function reachableTools(ctx: ToolReachContext): readonly Tool[] {
  const surface = surfaceOf(ctx);
  if (!reachesCatalog(ctx)) return surface;
  return Array.isArray(ctx.catalogTools) && ctx.catalogTools.length > 0
    ? ctx.catalogTools
    : surface;
}

/** Whether this conversation may call `name`. */
export function isToolReachable(ctx: ToolReachContext, name: string, tool?: Tool): boolean {
  const identity = tool ?? ctx.catalogTools?.find((entry) => entry.name === name) ?? { name };
  return (
    isSessionToolAllowed(ctx, identity) &&
    (reachesCatalog(ctx) || surfaceOf(ctx).some((tool) => tool.name === name))
  );
}
