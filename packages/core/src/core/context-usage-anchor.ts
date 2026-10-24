import type { AgentContext } from '@wrongstack/contracts/types/context';
import { realAnchoredInputTokens } from '../utils/token-estimate.js';

type UsageContext = Pick<
  AgentContext,
  'messages' | 'systemPrompt' | 'tools' | 'meta' | 'lastRealInputTokens' | 'lastRequestTokens'
>;

export interface RequestPromptBasis {
  messageCount: number;
  systemPrompt: unknown;
  tools: unknown;
}

const requestBases = new WeakMap<object, RequestPromptBasis>();
const usageBases = new WeakMap<object, RequestPromptBasis>();
const requestTokenBases = new WeakMap<object, RequestPromptBasis>();

export function captureRequestPromptBasis(ctx: UsageContext): RequestPromptBasis {
  return { messageCount: ctx.messages.length, systemPrompt: ctx.systemPrompt, tools: ctx.tools };
}

export function bindRequestPromptBasis(request: object, basis: RequestPromptBasis): void {
  requestBases.set(request, basis);
}

/** Track stash provenance without putting prompt/tool arrays in persisted meta. */
export function recordContextRequestBasis(ctx: UsageContext, request?: object): void {
  requestTokenBases.set(
    ctx,
    (request && requestBases.get(request)) ?? captureRequestPromptBasis(ctx),
  );
}

export function requestTokenBasisStillCurrent(ctx: UsageContext): boolean {
  const basis = requestTokenBases.get(ctx);
  return !basis || (basis.systemPrompt === ctx.systemPrompt && basis.tools === ctx.tools);
}

export function requestPromptStillCurrent(ctx: UsageContext, request: object): boolean {
  const basis = requestBases.get(request);
  return !basis || (basis.systemPrompt === ctx.systemPrompt && basis.tools === ctx.tools);
}

export function recordContextUsageAnchor(
  ctx: UsageContext,
  request: object,
  tokens: number,
  fallbackMessageCount: number,
): void {
  const basis = requestBases.get(request) ?? captureRequestPromptBasis(ctx);
  usageBases.set(ctx, basis);
  ctx.lastRealInputTokens = tokens;
  ctx.meta['realAnchorMsgCount'] = requestBases.has(request)
    ? basis.messageCount
    : fallbackMessageCount;
}

/** Provider usage includes the old system and schemas, not only message history. */
export function readRealAnchoredContextTokens(ctx: UsageContext): number | null {
  const basis = usageBases.get(ctx);
  if (basis && (basis.systemPrompt !== ctx.systemPrompt || basis.tools !== ctx.tools)) {
    usageBases.delete(ctx);
    ctx.lastRealInputTokens = undefined;
    // A new request may already have refreshed its stash for this epoch.
    // Discard only stashes that still describe the previous prompt basis.
    if (!requestTokenBasisStillCurrent(ctx)) {
      ctx.lastRequestTokens = undefined;
      delete ctx.meta['lastRequestTokensAt'];
    }
    delete ctx.meta['realAnchorMsgCount'];
  }
  return realAnchoredInputTokens(
    ctx.messages,
    ctx.lastRealInputTokens,
    typeof ctx.meta?.['realAnchorMsgCount'] === 'number'
      ? ctx.meta['realAnchorMsgCount']
      : undefined,
  );
}
