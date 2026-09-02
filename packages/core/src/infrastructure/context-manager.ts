import type { Context } from '../core/context.js';
import type { Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Tool } from '../types/tool.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { estimateMessageTokens, estimateRequestTokens } from '../utils/token-estimate.js';

/**
 * Context introspection and management tool.
 * Allows the model to:
 *   - "check"  → see token budget and message counts
 *   - "summary" → summarize and replace a range of messages
 *   - "prune"  → remove specific message indices
 *   - "add_note" → inject a summary note at a specific point
 *   - "compact" → run compaction via the injected compactor
 */
export const CONTEXT_MANAGER_TOOL_NAME = 'context_manager';

export type ContextManagerAction =
  | 'check'
  | 'summary'
  | 'prune'
  | 'add_note'
  | 'compact'
  | 'repair';

export interface ContextManagerInput {
  action: ContextManagerAction;
  /** 0-based message indices for prune/summary (inclusive). */
  from?: number | undefined;
  to?: number | undefined;
  /** Text for add_note / summary actions. For summary, this is the LLM-provided summary text. */
  text?: string | undefined;
  /** Inject after which index (for add_note). Defaults to prepend (0). */
  afterIndex?: number | undefined;
  /**
   * System prompt blocks for accurate total token estimation in check action.
   * When provided, check returns the full API request estimate
   * (messages + system + tools) instead of just message tokens.
   */
  systemPrompt?: unknown | undefined;
  /**
   * Registered tools for accurate total token estimation in check action.
   * Each tool's name + description + inputSchema is counted.
   */
  tools?: { name: string; description?: string | undefined; inputSchema: unknown }[];
}

export interface ContextManagerResult {
  action: ContextManagerAction;
  beforeTokens: number;
  afterTokens?: number | undefined;
  removedCount?: number | undefined;
  messageCount: number;
  summary?: string | undefined;
  notes?: string | undefined;
  repaired?:
    | {
        removedToolUses: string[];
        removedToolResults: string[];
        removedMessages: number;
      }
    | undefined;
}

/**
 * Options for creating a context manager tool.
 * `compactor` is required for the "compact" action; without it the action returns an error.
 */
export interface ContextManagerToolOptions {
  compactor?: Compactor | undefined;
  /**
   * Optional sub-LLM summarizer. When provided, the "summary" action calls this
   * to produce real summaries of message ranges instead of placeholder text.
   * (signature matches Provider.complete — return the summary text in result.content[0].text)
   */
  summarizer?: ((messages: Message[]) => Promise<string>) | undefined;
  /**
   * Minimum full-request token count before the compact action is allowed to run.
   * Prevents unnecessary compaction calls when context is small.
   * Default: 0 (always allow). Set to ~5000 for meaningful compaction targets.
   */
  minCompactThreshold?: number | undefined;
  /**
   * Minimum token growth required before retrying after a NOOP compaction.
   * A NOOP is when compaction saved nothing (preserveK protects everything,
   * no oversized tool_results). Default: 2000.
   */
  noopRetryDeltaTokens?: number | undefined;
  /**
   * Provider's max context window in tokens. Used to compute a relative
   * threshold when `minCompactThreshold` is not set. Default: 128_000.
   */
  maxContext?: number | undefined;
  /**
   * Fraction of maxContext that triggers compaction. Only used when
   * `minCompactThreshold` is not set. Default: 0.5 (50% of maxContext).
   */
  compactThresholdFraction?: number | undefined;
}

/** Messages-only token estimate. Delegates to the canonical shared estimator
 *  so the context_manager tool agrees with compaction and the `/context` bar. */
function roughEstimate(messages: Message[]): number {
  return estimateMessageTokens(messages);
}

export function createContextManagerTool(
  opts: ContextManagerToolOptions = {},
): Tool<ContextManagerInput, ContextManagerResult> {
  const minCompactThreshold = opts.minCompactThreshold ?? 0;
  const noopRetryDeltaTokens = opts.noopRetryDeltaTokens ?? 1_000;
  /** Hard override for maxContext. When absent, the runtime value from ctx.provider is used. */
  const configuredMaxContext = opts.maxContext;
  const compactThresholdFraction = opts.compactThresholdFraction ?? 0.4;

  // Tracks the most recent NOOP attempt so we can skip retry until context grows.
  let lastNoopTokens = 0;

  return {
    name: CONTEXT_MANAGER_TOOL_NAME,
    description:
      'Inspect or reorganize the conversation context window. ' +
      'Use "check" to see token budget. ' +
      'Use "summary" to collapse a message range into a concise note (provide "text" for custom summary). ' +
      'Use "prune" to remove specific messages by index. ' +
      'Use "add_note" to inject a summary note. ' +
      'Use "compact" to run aggressive compaction. ' +
      'Use "repair" to remove orphan tool_use/tool_result blocks after manual context surgery.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'summary', 'prune', 'add_note', 'compact', 'repair'],
          description: 'The context operation to perform.',
        },
        from: {
          type: 'number',
          description: 'Start index (inclusive) for summary/prune operations.',
        },
        to: {
          type: 'number',
          description: 'End index (inclusive) for summary/prune operations.',
        },
        text: {
          type: 'string',
          description:
            'Summary or note text. For "summary": the model-provided summary of the removed range. ' +
            'For "add_note": the note to inject.',
        },
        afterIndex: {
          type: 'number',
          description: 'Insert after this index (for add_note). Defaults to prepend (0).',
        },
      },
      required: ['action'],
    },
    permission: 'auto',
    // Mutates only the in-memory conversation context, like the todo tool.
    // It must stay auto-runnable so the model can inspect/repair/compact its
    // own context without hitting a permission prompt loop.
    mutating: false,

    async execute(input: ContextManagerInput, ctx: Context): Promise<ContextManagerResult> {
      const messages = ctx.messages;
      const beforeTokens = roughEstimate(messages);

      // When ctx.state is available, route mutations through the observer
      // layer so subscribers stay in sync. Fall back to direct mutation for
      // tests and environments that haven't wired ConversationState.
      const applyMessages = (next: Message[]) => {
        const repaired = repairToolUseAdjacency(next);
        const finalMessages = repaired.messages;
        // Skip if finalMessages === messages (no-op: repair returned the same array).
        // This also prevents the self-spread bug where spreading an array into
        // splice(0, 0, ...arr) on the same array reference empties it.
        if (finalMessages === messages) return repaired.report;
        if (ctx.state) {
          ctx.state.replaceMessages(finalMessages);
        } else {
          // push(...) is O(k) with no element shift, unlike splice(0, 0, ...) which
          // shifts all existing elements before inserting at position 0.
          messages.length = 0;
          messages.push(...finalMessages);
        }
        return repaired.report;
      };

      switch (input.action) {
        case 'check': {
          // Prefer the full API request estimate when systemPrompt + tools are available.
          // This is the accurate number for context-window bar display.
          // Falls back to roughEstimate (messages-only) for backward compat and test environments.
          const estimate =
            input.systemPrompt != null && Array.isArray(input.tools)
              ? estimateRequestTokens(messages, input.systemPrompt, input.tools)
              : { total: beforeTokens, messages: beforeTokens, systemPrompt: 0, tools: 0 };
          return {
            action: 'check',
            beforeTokens: estimate.total,
            messageCount: messages.length,
            notes: JSON.stringify({
              messages: messages.length,
              tokens: estimate.total,
              msgTokens: estimate.messages,
              sysTokens: estimate.systemPrompt,
              toolTokens: estimate.tools,
              readFiles: ctx.readFiles.size,
              todos: ctx.todos.length,
              inProgress: ctx.todos.filter((t) => t.status === 'in_progress').length,
            }),
          };
        }

        case 'repair': {
          const repair = applyMessages([...messages]);
          const afterTokens = roughEstimate(ctx.messages);
          return {
            action: 'repair',
            beforeTokens,
            afterTokens,
            messageCount: ctx.messages.length,
            repaired: repair.changed
              ? {
                  removedToolUses: repair.removedToolUses,
                  removedToolResults: repair.removedToolResults,
                  removedMessages: repair.removedMessages,
                }
              : undefined,
            notes: repair.changed
              ? 'Context tool-call adjacency repaired.'
              : 'Context tool-call adjacency already valid.',
          };
        }

        case 'compact': {
          if (!opts.compactor) {
            return {
              action: 'compact',
              beforeTokens,
              messageCount: messages.length,
              notes: 'No compactor registered. Use /compact aggressive via slash command instead.',
            };
          }
          // Compute full request tokens for threshold check.
          const fullEstimate =
            input.systemPrompt != null && Array.isArray(input.tools)
              ? estimateRequestTokens(messages, input.systemPrompt, input.tools)
              : { total: beforeTokens, messages: beforeTokens, systemPrompt: 0, tools: 0 };
          const currentTokens = fullEstimate.total;

          // Resolve maxContext at execution time from the live provider capabilities.
          // This is the actual model limit — from models.dev catalog, provider config,
          // or explicit effectiveMaxContext override. Falls back to the creation-time
          // value only when no runtime value is available (e.g. in test environments).
          const runtimeMaxContext =
            configuredMaxContext ?? ctx.provider?.capabilities?.maxContext ?? 128_000;
          const runtimeThreshold =
            minCompactThreshold > 0
              ? minCompactThreshold
              : Math.floor(runtimeMaxContext * compactThresholdFraction);

          // NOOP retry prevention: skip if the previous compaction saved nothing
          // and context hasn't grown enough to make another attempt worthwhile.
          if (lastNoopTokens > 0) {
            const delta = currentTokens - lastNoopTokens;
            if (delta < noopRetryDeltaTokens) {
              return {
                action: 'compact',
                beforeTokens,
                afterTokens: beforeTokens,
                messageCount: messages.length,
                notes: `Compact is a NOOP retry: context grew only ${delta} tokens since the last no-op attempt (threshold: ${noopRetryDeltaTokens}). Skip until more content accumulates.`,
              };
            }
          }

          // Minimum threshold check: skip if context is too small to benefit.
          if (runtimeThreshold > 0 && currentTokens < runtimeThreshold) {
            return {
              action: 'compact',
              beforeTokens,
              afterTokens: beforeTokens,
              messageCount: messages.length,
              notes: `Context tokens (${currentTokens}) below compact threshold (${runtimeThreshold}, based on provider maxContext ${runtimeMaxContext}). Skipping.`,
            };
          }

          const report = await opts.compactor.compact(ctx);
          ctx.clearFileTracking();

          // When ctx.state is not wired, the compactor's replaceMessages calls are
          // no-ops — repairToolUseAdjacency was still called inside the compactor but
          // the result was never committed. Run repair once to commit via the fallback.
          // When ctx.state IS wired, the compactor already committed the repair.
          let repaired = report.repaired;
          let afterTokens: number;
          if (!ctx.state) {
            const repair = applyMessages([...ctx.messages]);
            repaired = report.repaired ?? (repair.changed ? repair : undefined);
            afterTokens = repair.changed ? roughEstimate(ctx.messages) : report.after;
          } else {
            afterTokens = report.after;
          }

          // Record NOOP state: did compaction actually reduce tokens?
          const reduced = report.fullRequestTokensBefore > report.fullRequestTokensAfter;
          const repairedSomething = !!report.repaired;
          if (reduced || repairedSomething) {
            lastNoopTokens = 0;
          } else {
            lastNoopTokens = currentTokens;
          }

          return {
            action: 'compact',
            beforeTokens,
            afterTokens,
            messageCount: ctx.messages.length,
            repaired: repaired
              ? {
                  removedToolUses: repaired.removedToolUses,
                  removedToolResults: repaired.removedToolResults,
                  removedMessages: repaired.removedMessages,
                }
              : undefined,
          };
        }

        case 'prune': {
          const from = input.from ?? 0;
          const to = input.to ?? messages.length - 1;
          if (from < 0 || to >= messages.length || from > to) {
            return {
              action: 'prune',
              beforeTokens,
              messageCount: messages.length,
              notes: `Invalid range [${from}, ${to}] for ${messages.length} messages.`,
            };
          }
          const copy = [...messages];
          const removed = copy.splice(from, to - from + 1);
          ctx.clearFileTracking();
          const repair = applyMessages(copy);
          const afterTokens = roughEstimate(ctx.messages);
          return {
            action: 'prune',
            beforeTokens,
            afterTokens,
            messageCount: ctx.messages.length,
            removedCount: removed.length,
            repaired: repair.changed
              ? {
                  removedToolUses: repair.removedToolUses,
                  removedToolResults: repair.removedToolResults,
                  removedMessages: repair.removedMessages,
                }
              : undefined,
          };
        }

        case 'add_note': {
          const noteText = input.text ?? '(no summary)';
          const afterIdx = Math.min(input.afterIndex ?? 0, messages.length);
          const noteMsg: Message = {
            role: 'system',
            content: `[note: ${noteText}]`,
          };
          const copy = [...messages];
          copy.splice(afterIdx, 0, noteMsg);
          const repair = applyMessages(copy);
          const afterTokens = roughEstimate(ctx.messages);
          return {
            action: 'add_note',
            beforeTokens,
            afterTokens,
            messageCount: ctx.messages.length,
            summary: noteText,
            repaired: repair.changed
              ? {
                  removedToolUses: repair.removedToolUses,
                  removedToolResults: repair.removedToolResults,
                  removedMessages: repair.removedMessages,
                }
              : undefined,
          };
        }

        case 'summary': {
          const from = input.from ?? 0;
          const to = input.to ?? messages.length - 1;
          if (from < 0 || to >= messages.length || from > to) {
            return {
              action: 'summary',
              beforeTokens,
              messageCount: messages.length,
              notes: `Invalid range [${from}, ${to}] for ${messages.length} messages.`,
            };
          }
          const summaryText =
            input.text ?? '[summary placeholder — provide "text" to record the summary]';
          const summaryMsg: Message = {
            role: 'system',
            content: `[summary of messages ${from}–${to}]: ${summaryText}`,
          };
          const copy = [...messages];
          copy.splice(from, to - from + 1, summaryMsg);
          ctx.clearFileTracking();
          const repair = applyMessages(copy);
          const afterTokens = roughEstimate(ctx.messages);
          return {
            action: 'summary',
            beforeTokens,
            afterTokens,
            messageCount: ctx.messages.length,
            summary: summaryText,
            repaired: repair.changed
              ? {
                  removedToolUses: repair.removedToolUses,
                  removedToolResults: repair.removedToolResults,
                  removedMessages: repair.removedMessages,
                }
              : undefined,
          };
        }

        default:
          return {
            action: input.action,
            beforeTokens,
            messageCount: messages.length,
            notes: `Unknown action: ${input.action}`,
          };
      }
    },
  };
}

/** Pre-built instance with no compactor — compact action will return an error. */
export const contextManagerTool: Tool<ContextManagerInput, ContextManagerResult> =
  createContextManagerTool();
