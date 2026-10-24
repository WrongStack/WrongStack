/**
 * Per-iteration context injectors (btw notes, session notes, leader
 * deliveries, queue awareness) and the iteration-limit check for the agent
 * loop. Split out of agent-loop.ts; bound to one agent's internals.
 */
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { AgentCoordinationPort } from './agent-coordination.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { type Context, resolveEventSessionId, resolveOwningSessionId } from './context.js';
import { requestLimitExtension } from './iteration-limit.js';
import { buildQueuedMessagesBlock, consumeQueuedMessagesUpdate } from './queued-messages.js';
import { buildSessionNoteBlock, consumeSessionNotes } from './session-notes.js';

/**
 * The agent fields the injectors read. Structural on purpose: importing
 * AgentInternals or agent-types would tie this module to the agent-loop
 * type graph (the architecture gate fails on new type cycles).
 */
export interface AgentLoopInjectorHost {
  readonly ctx: Context;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly autoExtendLimit: boolean;
  readonly maxAutoExtensions: number;
}

/** The run result `checkIterationLimit` ends a run with (a RunResult). */
export interface IterationLimitExit {
  status: 'max_iterations';
  iterations: number;
  delegateSummaries: Array<{ summary: string; ok: boolean }>;
}

export function createAgentLoopInjectors(
  a: AgentLoopInjectorHost,
  /** Host-bound coordination; leader deliveries drain only when present. */
  coordination?: AgentCoordinationPort | undefined,
) {
  function foldBlockIntoConversation(block: TextBlock): void {
    if (!a.ctx.state.appendBlockToLastUserMessage(block)) {
      a.ctx.state.appendMessage({
        role: 'user',
        content: [block],
        origin: 'runtime',
        authoredLength: 0,
      });
    }
  }

  /**
   * `onMailboxBlock` takes delivery of the request-scoped mailbox notes (they
   * ride the live-context tail); without it they fold into the conversation.
   */
  function injectPendingBtwNotes(onMailboxBlock?: (block: TextBlock) => void): void {
    const notes = consumeBtwNotes(a.ctx);
    if (notes.length === 0) return;
    const mailboxNotes = notes.filter((note) => note.startsWith('[MAILBOX BTW]'));
    const regularNotes = notes.filter((note) => !note.startsWith('[MAILBOX BTW]'));
    if (regularNotes.length > 0) {
      foldBlockIntoConversation({ type: 'text', text: buildBtwBlock(regularNotes) });
    }
    if (mailboxNotes.length > 0) {
      const block: TextBlock = { type: 'text', text: buildBtwBlock(mailboxNotes) };
      if (onMailboxBlock) onMailboxBlock(block);
      else foldBlockIntoConversation(block);
    }
  }

  function injectPendingSessionNotes(): void {
    const notes = consumeSessionNotes(a.ctx);
    if (notes.length === 0) return;
    foldBlockIntoConversation({ type: 'text', text: buildSessionNoteBlock(notes) });
  }

  /** Session ids this agent answers for: the run-pinned one and its owner. */
  function ownSessionIds(): string[] {
    const ids = new Set<string>();
    try {
      ids.add(resolveEventSessionId(a.ctx));
    } catch {
      /* no session bound */
    }
    try {
      ids.add(resolveOwningSessionId(a.ctx));
    } catch {
      /* no session bound */
    }
    return [...ids].filter((id) => typeof id === 'string' && id.length > 0);
  }

  /**
   * Fold results owed to this session's leader (settled background
   * `delegate` calls) into the conversation. Leader only: workers share this
   * loop handler, and a worker of the same session must never drain the
   * leader's results. Bounded per iteration; the rest wait for the next one.
   */
  async function injectPendingDeliveries(): Promise<void> {
    await coordination?.drainLeaderDeliveries(a, ownSessionIds(), foldBlockIntoConversation);
  }

  function injectQueueAwareness(): void {
    const items = consumeQueuedMessagesUpdate(a.ctx);
    if (!items) return;
    foldBlockIntoConversation({ type: 'text', text: buildQueuedMessagesBlock(items) });
  }

  async function checkIterationLimit(
    iterationIndex: number,
    limit: number,
    hasHardLimit: boolean,
    currentIterations: number,
    delegateSummaries: Array<{ summary: string; ok: boolean }>,
    extensionsUsed: number,
  ): Promise<{ limit: number; exit?: IterationLimitExit | undefined; extended?: boolean }> {
    if (hasHardLimit && iterationIndex >= limit) {
      // The auto-grant is BOUNDED. `requestLimitExtension` resolves to +100
      // whenever `autoExtend` is true and no listener denies synchronously —
      // and no shipped listener ever denies (the only subscribers are a
      // metrics counter and two UI forwarders). Passing `autoExtend: true`
      // unconditionally therefore turned every configured `maxIterations`
      // into "no limit at all": each overrun bought another 100 turns, for
      // ever. Once this run has spent its extension allowance, stop asking
      // and let the run end at `max_iterations` — that is the only thing
      // that makes a configured iteration budget mean anything.
      const allowanceLeft = extensionsUsed < a.maxAutoExtensions;
      const extendBy = await requestLimitExtension({
        events: a.events,
        sessionId: resolveEventSessionId(a.ctx),
        currentIterations,
        currentLimit: limit,
        autoExtend: a.autoExtendLimit && allowanceLeft,
        // With the allowance spent there is nothing to wait for: no listener
        // grants today, so the default 30s window would only stall the exit.
        ...(allowanceLeft ? {} : { timeoutMs: 0 }),
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        a.logger.info(
          `Iteration limit extended by ${extendBy} (new limit: ${newLimit}, ` +
            `extension ${extensionsUsed + 1}/${a.maxAutoExtensions})`,
        );
        return { limit: newLimit, extended: true };
      }
      if (!allowanceLeft) {
        a.logger.warn(
          `Iteration limit reached at ${currentIterations} turns after ` +
            `${extensionsUsed} extension(s) — stopping. Raise tools.maxIterations or ` +
            'tools.maxAutoExtensions if this task legitimately needs more turns.',
        );
      }
      return {
        limit,
        exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries },
      };
    }
    return { limit };
  }

  return {
    foldBlockIntoConversation,
    injectPendingBtwNotes,
    injectPendingSessionNotes,
    injectPendingDeliveries,
    injectQueueAwareness,
    ownSessionIds,
    checkIterationLimit,
  };
}
