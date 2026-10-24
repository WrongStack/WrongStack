/**
 * Compaction on a route whose agent keeps its own context (an ACP agent
 * leading the session): the agent compacts its conversation itself, so a
 * `/compact` or a UI button asks it to. Trimming WrongStack's transcript
 * would free none of the agent's window and would cost the transcript a
 * later model switch or resume carries over.
 */

import type { CompactReport } from '@wrongstack/contracts/types/compactor';
import { ProviderError } from '@wrongstack/contracts/types/provider';
import {
  agentSessionKey,
  readAgentContext,
  recordAgentContext,
} from '../core/agent-owned-context.js';
import type { Context } from '../core/context.js';

export async function compactAgentOwnedContext(ctx: Context): Promise<CompactReport> {
  const provider = ctx.provider;
  if (!provider.compactOwnContext) {
    throw new ProviderError(
      `${provider.id} manages its own context and cannot compact it on request.`,
      400,
      false,
      provider.id,
      { kind: 'invalid_request' },
    );
  }
  const before = readAgentContext(ctx)?.used ?? 0;
  const reported = await provider.compactOwnContext({
    sessionId: agentSessionKey(ctx),
    signal: ctx.signal ?? new AbortController().signal,
  });
  recordAgentContext(ctx, reported);
  const after = reported?.used ?? before;
  return {
    before,
    after,
    fullRequestTokensBefore: before,
    fullRequestTokensAfter: after,
    reductions: before > after ? [{ phase: 'summary', saved: before - after }] : [],
  };
}
