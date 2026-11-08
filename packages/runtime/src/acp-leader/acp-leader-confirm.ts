/**
 * Asking the user about an ACP leader's permission request on a surface that
 * answers confirmations itself (the TUI, the WebUI): the request goes out as
 * the same `tool.confirm_needed` event the leader's own tools raise, so it
 * shows as that surface's ordinary approval prompt, in the tab the session
 * belongs to. Nobody answering within two minutes, or the turn stopping,
 * refuses it: an outside agent's call is never approved by default.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { PermissionPolicy, Tool } from '@wrongstack/contracts/types';
import { confirmObserverCount } from '@wrongstack/core/agent';
import { DEFAULT_ALWAYS_TRUST_TTL_MS, scopedApprovalPattern } from '@wrongstack/core/security';

const ACP_CONFIRM_TIMEOUT_MS = 120_000;

type Answer = 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny';

export interface EventConfirmRequest {
  events: EventBus;
  sessionId: string | undefined;
  tool: Tool;
  input: unknown;
  toolUseId: string;
  suggestedPattern: string;
  signal: AbortSignal;
  /** Where an "always" or "deny" answer is remembered, as for the leader's own tools. */
  permission?: Pick<PermissionPolicy, 'trust' | 'deny'> | undefined;
  /** The context the policy evaluates the agent's calls in: an exact-input answer is keyed to it. */
  context: Parameters<PermissionPolicy['evaluate']>[2];
  timeoutMs?: number | undefined;
}

/** Resolves true when the user approved the call. */
export async function confirmThroughEvents(req: EventConfirmRequest): Promise<boolean> {
  // Only an observer (the HQ mirror) is listening: no one can answer.
  if (req.events.listenerCount('tool.confirm_needed') - confirmObserverCount() <= 0) return false;
  const timeoutMs = req.timeoutMs ?? ACP_CONFIRM_TIMEOUT_MS;
  const answer = await new Promise<Answer | 'abort'>((resolve) => {
    let settled = false;
    const settle = (choice: Answer | 'abort', source: 'user' | 'abort' | 'brain_timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      req.events.emit('tool.confirm_resolved', {
        sessionId: req.sessionId,
        toolUseId: req.toolUseId,
        toolName: req.tool.name,
        decision: choice,
        source,
        ...(source === 'brain_timeout'
          ? { rationale: 'Nobody answered; an outside agent is not approved by default.' }
          : {}),
      });
      resolve(choice);
    };
    const onAbort = () => settle('abort', 'abort');
    const timer = setTimeout(() => settle('no', 'brain_timeout'), timeoutMs);
    timer.unref?.();
    if (req.signal.aborted) {
      settle('abort', 'abort');
      return;
    }
    req.signal.addEventListener('abort', onAbort, { once: true });
    req.events.emit('tool.confirm_needed', {
      sessionId: req.sessionId,
      tool: req.tool,
      input: req.input,
      toolUseId: req.toolUseId,
      suggestedPattern: req.suggestedPattern,
      deadlineAt: Date.now() + timeoutMs,
      resolve: (decision) => settle(decision, 'user'),
    });
  });
  if (answer === 'abort' || answer === 'no') return false;
  await rememberConfirmAnswer(req, answer);
  return answer !== 'deny';
}

/**
 * Keep an "always" or "deny" answer the way the leader's own prompt keeps it,
 * whichever prompt (events or the REPL's) the user answered on.
 */
export async function rememberConfirmAnswer(
  req: Pick<EventConfirmRequest, 'tool' | 'input' | 'suggestedPattern' | 'permission' | 'context'>,
  answer: Answer,
): Promise<void> {
  try {
    if (answer === 'deny') {
      await req.permission?.deny({ tool: req.tool.name, pattern: req.suggestedPattern });
    } else if (answer !== 'yes' && answer !== 'no') {
      // As the leader's own prompt keeps it: the scope the user picked, for a day.
      await req.permission?.trust({
        tool: req.tool.name,
        pattern: scopedApprovalPattern(
          answer,
          req.tool,
          req.input,
          req.context,
          req.suggestedPattern,
        ),
        ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
      });
    }
  } catch {
    // Remembering the answer is best-effort; this call is decided either way.
  }
}
