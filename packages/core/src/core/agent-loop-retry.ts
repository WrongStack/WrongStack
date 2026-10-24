import {
  AgentError,
  ERROR_CODES,
  toWrongStackError,
  type WrongStackError,
} from '@wrongstack/contracts/types/errors';
import { recordPromptJournalEntry } from '../prompts/prompt-journal.js';
import { toErrorMessage } from '../utils/error.js';
import { type Context, resolveEventSessionId } from './context.js';

interface RetryJournalHost {
  readonly ctx: Context;
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Best-effort journal record for a recovered provider error (self-healing
 * retry). Mirrors the CLI recorder's guard: only writes when the context has a
 * project root, and failures are swallowed — journal I/O must never block the
 * loop.
 */
export function recordSelfHealingRetry(a: RetryJournalHost, err: unknown, reason: string): void {
  const projectRoot = a.ctx.projectRoot;
  if (!projectRoot) return;
  void recordPromptJournalEntry({
    projectRoot,
    sessionId: resolveEventSessionId(a.ctx),
    category: 'self_healing_retry',
    content: toErrorMessage(err),
    decisionReason: reason,
    model: a.ctx.model,
    provider: a.ctx.provider?.id,
    activeTools: a.ctx.tools?.map((tool) => tool.name) ?? [],
  }).catch(() => {});
}

/**
 * Best-effort journal record for a text-marker autonomous continue
 * (`[continue]` / `[next step]` / `[proceed]` emitted as final text without
 * the `continue_to_next_iteration` tool call). Same guard as
 * `recordSelfHealingRetry` — only writes when the context has a project root,
 * and failures are swallowed so journal I/O never blocks the loop.
 */
export function recordAutonomousContinue(a: RetryJournalHost, text: string): void {
  const projectRoot = a.ctx.projectRoot;
  if (!projectRoot) return;
  void recordPromptJournalEntry({
    projectRoot,
    sessionId: resolveEventSessionId(a.ctx),
    category: 'autonomous_next_step',
    content: text,
    decisionReason: 'text-marker autonomous continue',
    model: a.ctx.model,
    provider: a.ctx.provider?.id,
    activeTools: a.ctx.tools?.map((tool) => tool.name) ?? [],
  }).catch(() => {});
}

export function signalAbortReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (r instanceof Error) return r.message || r.name;
  if (typeof r === 'string' && r.length > 0) return r;
  return 'aborted';
}

/**
 * The error an `aborted` result carries: always `AGENT_ABORTED`.
 *
 * `toWrongStackError` passes an existing WrongStackError through untouched, so
 * a stop that severed a provider request returned the provider's own error —
 * a recoverable `PROVIDER_NETWORK_ERROR` — and surfaces read it as a transient
 * provider failure (the WebUI armed its auto-continue countdown on it). The
 * severed request's error stays reachable as the cause.
 */
export function abortedRunError(err: unknown): WrongStackError {
  const wrapped = toWrongStackError(err, 'AGENT_ABORTED');
  if (wrapped.code === ERROR_CODES.AGENT_ABORTED) return wrapped;
  return new AgentError({
    message: wrapped.message,
    code: ERROR_CODES.AGENT_ABORTED,
    cause: wrapped,
  });
}
