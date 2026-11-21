import { createHash } from 'node:crypto';
import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { sessionToolGroupRevision } from '../registry/session-tool-groups.js';
import { isToolReachable } from '../registry/session-tool-reach.js';
import { stableStringify } from '../replay/hash.js';
import type { RequestLayoutTailEntry } from '../utils/request-layout.js';

/**
 * Blocks that belong to the next provider request only — raw mailbox mail is
 * the case that matters. They ride the live-context tail (after the deepest
 * cache boundary) instead of the durable conversation.
 *
 * They used to be folded into the last user message and removed again after
 * the response. That message is exactly where the previous request closed its
 * cached prefix, so the removal rewrote the cache boundary on every mailbox
 * turn: the next request missed the entry and re-wrote that turn's history.
 * Kept out of history, the conversation stays append-only and nothing has to
 * be cleaned up but this per-context list.
 */
const scoped = new WeakMap<object, RequestLayoutTailEntry[]>();
type SchemaContext = Parameters<typeof isToolReachable>[0];
const deferred = new WeakMap<
  SchemaContext,
  Map<
    string,
    {
      block: TextBlock;
      tool: Tool;
      groupRevision: object | undefined;
      sessionId: string | undefined;
    }
  >
>();

export function addRequestScopedBlock(ctx: object, block: TextBlock, source = 'mailbox'): void {
  const entries = scoped.get(ctx);
  if (entries) entries.push({ source, block });
  else scoped.set(ctx, [{ source, block }]);
}

/** Blocks for the request being built; empty when there are none. */
export function requestScopedEntries(ctx: object): readonly RequestLayoutTailEntry[] {
  const entries = scoped.get(ctx) ?? [];
  const session = ctx as SchemaContext;
  const schemas = deferred.get(session);
  if (!schemas?.size) return entries;
  return [
    ...entries,
    ...[...schemas.values()]
      .filter(
        ({ tool, groupRevision, sessionId }) =>
          sessionId === session.eventSessionId?.() &&
          groupRevision === sessionToolGroupRevision(session, tool.name) &&
          isToolReachable(session, tool.name) &&
          (session.catalogTools ?? session.tools ?? []).includes(tool),
      )
      .map(({ block }) => ({ block, source: 'tool-schema' })),
  ];
}

/** Keep the complete input contract out of durable tool-result history. */
export function stageDeferredToolSchema(ctx: SchemaContext, tool: Tool): string {
  const schema = stableStringify(tool.inputSchema);
  const revision = createHash('sha256').update(schema).digest('hex').slice(0, 16);
  let schemas = deferred.get(ctx);
  if (!schemas) {
    schemas = new Map();
    deferred.set(ctx, schemas);
  }
  schemas.set(tool.name, {
    tool,
    sessionId: ctx.eventSessionId?.(),
    groupRevision: sessionToolGroupRevision(ctx, tool.name),
    block: {
      type: 'text',
      text: `Deferred tool schema for ${tool.name} (revision ${revision}). Call it through tool_use with input matching this schema.\n${tool.description}\n${schema}`,
    },
  });
  return revision;
}

/** Drop the blocks once a response evaluated them (or the run ends). */
export function clearRequestScopedBlocks(ctx: object): void {
  scoped.delete(ctx);
  deferred.delete(ctx);
}
