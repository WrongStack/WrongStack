/**
 * `autonomy.nextSteps: 'required'` — every finished leader turn ends with
 * either a `<nextsteps>` block or the `<nextsteps-complete/>` marker.
 *
 * The prompt (`[nextsteps_gate]`) asks for one of the two. When the model
 * still ends a turn with neither, {@link maybeRequireNextSteps} asks it once
 * more in a side request: the same request it just answered plus its answer
 * and a short instruction, so the provider prefix cache covers almost all of
 * it and the suggestions come from the leader's full context. The side
 * exchange never enters history, the journal, or any event — only its result
 * does, appended through the `nextsteps` slot so every surface reads it from
 * the message text exactly like a block the model typed.
 *
 * A side answer of `<nextsteps-complete/>` (or anything unparseable) appends
 * nothing: no suggestion means `auto` autonomy has nothing to proceed with,
 * which is how a required-mode run ends.
 */

import type { Container } from '@wrongstack/contracts/kernel/container';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import {
  type NextStepsMode,
  resolveNextStepsMode,
} from '@wrongstack/contracts/types/config/autonomy';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { adaptDocumentsForModel } from '../utils/document-blocks.js';
import { toErrorMessage } from '../utils/error.js';
import { hasMeaningfulContent } from '../utils/message-invariants.js';
import { hasNextStepsCompleteMarker, parseNextSteps } from '../utils/next-steps.js';
import { hasOpenTodos } from '../utils/todos-format.js';
import type { Context } from './context.js';
import {
  hasNextStepsTag,
  MAX_PENDING_NEXT_STEPS,
  maybeAppendPendingNextSteps,
  writePendingNextSteps,
} from './next-steps-slot.js';

/** Only the services and context fields used by the next-steps side request. */
interface NextStepsHost {
  readonly container: Container;
  readonly ctx: Pick<Context, 'meta' | 'agentId' | 'signal' | 'todos' | 'tokenCounter'>;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
}

/** Upper bound for the side request; a slow answer must not hold the turn. */
const SIDE_REQUEST_TIMEOUT_MS = 30_000;

export const NEXT_STEPS_REQUIRED_PROMPT = [
  '[nextsteps_required]',
  'Your previous response ended the turn without a <nextsteps> block or the <nextsteps-complete/> marker, and the user requires one of them on every finished turn.',
  'Do not call tools and do not repeat or summarize your answer. Reply with ONLY one of:',
  "- a balanced <nextsteps> block with 1-4 exact prompt messages for the most useful remaining work toward the user's goal. Each item is submitted back to you verbatim as the next user prompt: agent-directed, self-contained, in the user's language, never a chore for the user.",
  "- <nextsteps-complete/> if the user's goal is fully achieved and no meaningful work remains.",
  '[/nextsteps_required]',
].join('\n');

/**
 * The live mode. A session-scoped `ctx.meta.nextStepsMode` (WebUI tabs keep
 * their own, like autonomy) wins over the process-wide `autonomy.nextSteps`,
 * which defaults to 'required'.
 *
 * 'required' is a product default of the configured hosts (CLI, TUI, WebUI),
 * not of the bare kernel: an embedder or test that binds no config store gets
 * 'optional', so a plain `Agent` never makes a provider call it did not ask
 * for — with a scripted provider that call would consume the next turn.
 */
export function readNextStepsMode(a: Pick<NextStepsHost, 'container' | 'ctx'>): NextStepsMode {
  const sessionMode = (a.ctx.meta as Record<string, unknown> | undefined)?.['nextStepsMode'];
  if (sessionMode === 'optional' || sessionMode === 'required') return sessionMode;
  try {
    const store = a.container?.safeResolve?.(TOKENS.ConfigStore);
    if (!store) return 'optional';
    return resolveNextStepsMode(store.get().autonomy?.nextSteps);
  } catch {
    return 'optional';
  }
}

/**
 * Only a natural end of turn qualifies. `max_tokens` is a truncation the loop
 * may continue, `refusal` has nothing to follow up on, and tool calls are
 * mid-turn.
 */
function endsTurnNaturally(stopReason: Response['stopReason']): boolean {
  return stopReason === undefined || stopReason === 'end_turn' || stopReason === 'stop_sequence';
}

/**
 * Fill in a missing `<nextsteps>` block for a required-mode turn.
 *
 * Returns `res` untouched unless the mode is 'required', this is the leader's
 * natural end of turn with no open todos, and the response carries neither a
 * block nor the completion marker. Never throws: a failed side request leaves
 * the turn as the model wrote it.
 */
export async function maybeRequireNextSteps(
  a: NextStepsHost,
  res: Response,
  req: Request,
  provider: Provider,
): Promise<Response> {
  const ctx = a.ctx;
  if (ctx.agentId !== 'leader') return res;
  if (!endsTurnNaturally(res.stopReason)) return res;
  if (ctx.signal.aborted) return res;
  if (hasOpenTodos(ctx.todos)) return res;
  if (!hasMeaningfulContent(res.content)) return res;
  if (readNextStepsMode(a) !== 'required') return res;

  const text = res.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
  if (hasNextStepsTag(text) || hasNextStepsCompleteMarker(text)) return res;

  const answer = res.content.filter(isTextBlock);
  const sideRequest: Request = {
    ...req,
    messages: [
      // Adapted per provider exactly like the main attempt (provider-runner):
      // a model without PDF input rejects document blocks.
      ...adaptDocumentsForModel(req.messages, provider.capabilities?.pdf === true),
      ...(answer.length > 0 ? [{ role: 'assistant' as const, content: answer }] : []),
      { role: 'user', content: [{ type: 'text', text: NEXT_STEPS_REQUIRED_PROMPT }] },
    ],
  };

  let reply: Response;
  try {
    reply = await provider.complete(sideRequest, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SIDE_REQUEST_TIMEOUT_MS)]),
    });
  } catch (err) {
    a.logger.warn?.(`nextsteps (required): side request failed: ${toErrorMessage(err)}`);
    return res;
  }
  // The side request is real spend on the session's model.
  ctx.tokenCounter.account(reply.usage, req.model, provider.id);
  if (ctx.signal.aborted) return res;

  const replyText = reply.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
  const steps = parseNextSteps(replyText).steps.slice(0, MAX_PENDING_NEXT_STEPS);
  if (steps.length === 0) {
    if (!hasNextStepsCompleteMarker(replyText)) {
      a.logger.debug?.('nextsteps (required): side request returned neither block nor marker');
    }
    return res;
  }
  writePendingNextSteps(
    ctx,
    steps.map((step) => (step.auto ? { text: step.text, auto: true } : { text: step.text })),
  );
  return maybeAppendPendingNextSteps(ctx, res);
}
