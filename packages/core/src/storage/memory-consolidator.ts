import type { RunResult } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { AfterRunHook, AgentExtension } from '../extension/extension-points.js';
import type { MemoryEntry, MemoryStore } from '../types/memory.js';
import type { Provider } from '../types/provider.js';
import type { OneShotOrchestrator } from '../execution/one-shot-llm.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ConsolidationOp {
  action: 'add' | 'edit' | 'delete';
  /** For add: the fact to remember. For edit: the new text replacing the old. */
  text?: string | undefined;
  /** For edit/delete: the query to match existing entries. */
  query?: string | undefined;
  /** Memory type for categorization. */
  type?: string | undefined;
  /** Tags for grouping. */
  tags?: string[] | undefined;
  /** Priority level. */
  priority?: string | undefined;
}

interface ConsolidationResponse {
  operations: ConsolidationOp[];
  summary?: string | undefined;
}

export interface MemoryConsolidatorOptions {
  memoryStore: MemoryStore;
  /**
   * Provider used for the consolidation LLM call. Uses the session's
   * provider by default.
   */
  provider?: Provider | undefined;
  /**
   * Model override for the consolidation call. Uses the session's model
   * by default. A smaller/faster model is recommended (e.g. deepseek-chat, haiku, flash).
   */
  model?: string | undefined;
  /**
   * Minimum session iterations before consolidation fires.
   * Sessions shorter than this are skipped (default 2).
   */
  minIterations?: number | undefined;
  /**
   * Maximum memory entries to include in the prompt as context.
   */
  maxExistingEntries?: number | undefined;
  /**
   * OneShotOrchestrator for the consolidation LLM call. When set, uses
   * it instead of the direct provider.complete() path, gaining fallback
   * chain support and cheap-model defaulting.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildConsolidationPrompt(
  finalText: string,
  iterations: number,
  existingEntries: MemoryEntry[],
): string {
  const existingBlock =
    existingEntries.length > 0
      ? `\n\nExisting memory entries:\n${existingEntries
          .map((e) => `- [${e.ts.slice(0, 10)}] ${e.text}`)
          .join('\n')}`
      : '';

  return renderInstructionTemplate(readBundledInstructionText('llm/memory-consolidator.md'), {
    iterations: String(iterations),
    summary: finalText.slice(0, 3000),
    existingEntries: existingBlock,
  });
}

// ── Consolidator ────────────────────────────────────────────────────────

export class SessionMemoryConsolidator implements AgentExtension {
  name = 'session-memory-consolidator';
  owner = 'core';

  private readonly memoryStore: MemoryStore;
  private readonly provider?: Provider | undefined;
  private readonly model?: string | undefined;
  private readonly minIterations: number;
  private readonly maxExistingEntries: number;
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;

  constructor(opts: MemoryConsolidatorOptions) {
    this.memoryStore = opts.memoryStore;
    this.provider = opts.provider;
    this.model = opts.model;
    this.minIterations = opts.minIterations ?? 2;
    this.maxExistingEntries = opts.maxExistingEntries ?? 15;
    this.oneShotOrchestrator = opts.oneShotOrchestrator;
  }

  afterRun: AfterRunHook = (ctx: Context, result: RunResult) => {
    // Only consolidate successful sessions with meaningful output
    if (result.status !== 'done') return;
    if (!result.finalText || result.finalText.trim().length < 20) return;
    if (result.iterations < this.minIterations) return;

    const provider = this.provider ?? ctx.provider;
    if (!provider?.complete) return;

    // Capture narrowed values for the fire-and-forget closure.
    const _finalText: string = result.finalText;
    const _iterations: number = result.iterations;
    const _model: string | undefined = this.model ?? ctx.model;

    // Fire-and-forget: consolidation is best-effort and should never block
    // session teardown (the LLM call can take up to 15s). The catch block
    // below prevents unhandled rejections.
    void (async () => {
      try {
        // Load existing memory for dedup context
        const existingEntries = await this.memoryStore.list('project-memory', this.maxExistingEntries);
        const prompt = buildConsolidationPrompt(
          _finalText,
          _iterations,
          existingEntries,
        );

        // Call the LLM with a focused, one-shot prompt
        let text: string;
        if (this.oneShotOrchestrator) {
          const oneShotResult = await this.oneShotOrchestrator.call({
            system: prompt,
            userPrompt: 'Review the session and return memory operations as JSON.',
            model: _model ?? 'deepseek-chat',
            maxTokens: 500,
            timeoutMs: 15_000,
            fallbackProfile: 'memory',
          });
          text = oneShotResult.text;
        } else {
          // Legacy path: direct provider.complete()
          const signal = AbortSignal.timeout(15_000);
          const response = await provider.complete(
            {
              model: _model,
              system: [{ type: 'text', text: prompt }],
              messages: [
                { role: 'user', content: 'Review the session and return memory operations as JSON.' },
              ],
              maxTokens: 500,
            },
            { signal },
          );
          text = response.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        }
        if (!text) return;

        // Extract JSON from possible markdown wrapper
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const parsed: ConsolidationResponse = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return;

        // Apply operations
        let added = 0;
        let edited = 0;
        let deleted = 0;

        for (const op of parsed.operations) {
          switch (op.action) {
            case 'add': {
              if (op.text?.trim()) {
                await this.memoryStore.remember(op.text.trim(), undefined, {
                  type: op.type as MemoryEntry['type'],
                  tags: op.tags,
                  priority: op.priority as MemoryEntry['priority'],
                });
                added++;
              }
              break;
            }
            case 'edit': {
              if (op.query && op.text?.trim()) {
                await this.memoryStore.forget(op.query);
                await this.memoryStore.remember(op.text.trim(), undefined, {
                  type: op.type as MemoryEntry['type'],
                  tags: op.tags,
                  priority: op.priority as MemoryEntry['priority'],
                });
                edited++;
              }
              break;
            }
            case 'delete': {
              if (op.query) {
                const n = await this.memoryStore.forget(op.query);
                deleted += n;
              }
              break;
            }
          }
        }

        if (added > 0 || edited > 0 || deleted > 0) {
          const parts: string[] = [];
          if (added) parts.push(`${added} added`);
          if (edited) parts.push(`${edited} edited`);
          if (deleted) parts.push(`${deleted} deleted`);
          // Log to stderr so it surfaces in the terminal
          process.stderr.write(`[memory] Session consolidation: ${parts.join(', ')}\n`);
        }
      } catch {
        // Silent — memory consolidation is best-effort, never blocks session cleanup
      }
    })();
  };
}
