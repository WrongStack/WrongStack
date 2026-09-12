/**
 * Mirror the plain REPL's permission prompt to HQ.
 *
 * Every other surface converges on the executor's confirm path, so one
 * listener on the EventBus mirrors them all. The REPL does not: its prompt is
 * asked by the permission policy's own `promptDelegate` inside `evaluate()`,
 * which never reaches that path and raises no event. Without this wrapper the
 * REPL is the one surface whose approvals are invisible from HQ — a partial
 * guarantee that is worse than either a whole one or none, because an operator
 * cannot tell which kind of session they are looking at.
 *
 * Two things make this honest rather than a hack:
 *
 *  - **The terminal read is cancellable.** When HQ answers first, the pending
 *    `readKey` is aborted so stdin comes out of raw mode and the user's next
 *    keystroke is not eaten by a question nobody is asking.
 *  - **The mirrored card has a heartbeat, not a fake deadline.** A terminal
 *    prompt waits for a keypress however long that takes, so it has no natural
 *    deadline to publish — but a card with no deadline breaks the single
 *    invariant the dashboard relies on ("pending cannot outlive its
 *    deadline"), and a card with a fake one vanishes while the question is
 *    still on screen. Renewing a short window on a timer keeps both true.
 *
 * The terminal prompt's own behaviour is deliberately unchanged: it still
 * blocks until answered, with no timeout of its own.
 *
 * @module permission-prompt-mirror
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalRegistry } from '@wrongstack/core/hq';
import { describeWriteTargets } from '@wrongstack/core/security';
import type { Tool } from '@wrongstack/core/types';

type PromptDecision = 'yes' | 'no' | 'always' | 'deny';

type PromptDelegate = (
  tool: Tool,
  input: unknown,
  suggestedPattern: string,
) => Promise<PromptDecision>;

type AbortablePromptDelegate = (
  tool: Tool,
  input: unknown,
  suggestedPattern: string,
  signal: AbortSignal,
) => Promise<PromptDecision>;

/**
 * How long a mirrored REPL card stays pending without a renewal, and how often
 * it is renewed. The gap between them is the worst-case time a card outlives
 * the process that raised it — a laptop that sleeps mid-prompt should not park
 * a permanent card on someone's dashboard.
 */
export const REPL_MIRROR_TTL_MS = 60_000;
export const REPL_MIRROR_HEARTBEAT_MS = 20_000;

export interface MirroredPromptDelegateDeps {
  /** The real terminal prompt. Must honour the abort signal it is handed. */
  inner: AbortablePromptDelegate;
  /**
   * Looked up per call, not captured: the registry is created during boot and
   * this delegate is built before it exists. Returning undefined simply means
   * no mirroring — the terminal prompt still works.
   */
  getRegistry: () => ApprovalRegistry | undefined;
  /** The session the prompt belongs to, so an HQ answer lands on it. */
  getSessionId?: (() => string | undefined) | undefined;
  now?: (() => number) | undefined;
}

export function makeMirroredPromptDelegate(deps: MirroredPromptDelegateDeps): PromptDelegate {
  const now = deps.now ?? Date.now;

  return async (tool, input, suggestedPattern): Promise<PromptDecision> => {
    const registry = deps.getRegistry();
    const controller = new AbortController();
    if (registry === undefined) {
      return deps.inner(tool, input, suggestedPattern, controller.signal);
    }

    // The policy has no tool_use id here — this prompt is raised before the
    // executor ever sees the call — so one is minted. Prefixed so a reader of
    // the event log can tell a REPL-mirrored approval from an executor one.
    const toolUseId = `repl:${randomUUID()}`;
    let settled = false;
    let remoteDecision: PromptDecision | undefined;

    const finish = registry.register({
      toolUseId,
      toolName: tool.name,
      sessionId: deps.getSessionId?.(),
      deadlineAt: now() + REPL_MIRROR_TTL_MS,
      input,
      suggestedPattern,
      ...(tool.riskTier ? { riskTier: tool.riskTier } : {}),
      decisionSource: 'default',
      writeTargets: describeWriteTargets(tool, input),
      destructive: tool.riskTier === 'destructive',
      resolve: (decision) => {
        if (settled) return;
        settled = true;
        remoteDecision = decision;
        // Takes the question off the terminal. Without this the REPL would sit
        // in raw mode waiting for a keypress to answer a decision already made.
        controller.abort();
      },
    });

    const heartbeat = setInterval(() => {
      registry.renew(toolUseId, now() + REPL_MIRROR_TTL_MS);
    }, REPL_MIRROR_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const typed = await deps.inner(tool, input, suggestedPattern, controller.signal);
      // HQ won the race: its answer is the decision, and the aborted terminal
      // read's empty return is discarded rather than read as a refusal.
      if (remoteDecision !== undefined) return remoteDecision;
      settled = true;
      // An aborted-but-unanswered read (Ctrl+C, stdin closed) returns ''. The
      // policy treats anything that is not an explicit grant as a refusal, and
      // so does the card.
      const decision: PromptDecision =
        typed === 'yes' || typed === 'always' || typed === 'deny' ? typed : 'no';
      finish(decision);
      return decision;
    } finally {
      clearInterval(heartbeat);
      // Idempotent: a no-op when HQ's answer already removed the entry.
      finish('no');
    }
  };
}

/**
 * Late-bound handle to the approval registry.
 *
 * The prompt delegate is built during container wiring; the registry is
 * created later, once the HQ telemetry layer comes up. Rather than reorder
 * boot for a feature that is optional by nature, the delegate reads through
 * this holder at call time — a prompt only ever fires long after both exist.
 * Empty simply means no mirroring.
 */
export interface ApprovalMirrorRef {
  current?: ApprovalRegistry | undefined;
  sessionId?: (() => string | undefined) | undefined;
}
