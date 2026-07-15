import { expectDefined } from '../utils/expect-defined.js';
import { estimateMessageTokens, estimateTextTokens } from '../utils/token-estimate.js';
import { isTextBlock } from '../types/blocks.js';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import type { MessageSelector, SelectorResult } from '../types/selector.js';
import type { OneShotOrchestrator } from '../execution/one-shot-llm.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
export interface LLMSelectorOptions {
  /** Provider used for the selector LLM call. Required. */
  provider: Provider;
  /** Model for the selector. Defaults to the provider's default model. */
  model?: string | undefined;
  /**
   * Maximum tokens to keep in context (target budget).
   * Selector will aim to keep total content below this.
   */
  maxContextTokens?: number | undefined;
  /**
   * Prompt instructing the selector how to behave.
   * Should guide the LLM on importance tiers and output format.
   */
  systemPrompt?: string | undefined;
  /**
   * Maximum output tokens for the selector LLM call.
   * Controls both the JSON response budget and the token reservation for the
   * history text budget calculation (default: 1024).
   */
  maxOutputTokens?: number | undefined;
  /**
   * OneShotOrchestrator for the selector LLM call. When set, uses it
   * instead of direct provider.complete(), gaining fallback chain support.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

const DEFAULT_SYSTEM_PROMPT = readBundledInstructionText('llm/llm-selector.md');

/**
 * Format messages as a compact text dump for the selector LLM.
 * Uses token estimation (not character count) to budget the output,
 * so long sessions don't silently truncate the selector's view of history.
 */
function formatMessages(messages: Message[], maxTokens = 2048): string {
  const lines: string[] = [];
  let usedTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = expectDefined(messages[i]);
    const role = m.role.padEnd(10, ' ');
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content.slice(0, 500);
    } else {
      const content = m.content as ContentBlock[];
      text = content
        .filter(isTextBlock)
        .map((b) => b.text)
        .join(' ');
      // Also capture tool names for context
      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (toolUses.length > 0) {
        text += ` [tools: ${toolUses.map((b) => (b as { name?: string }).name).filter(Boolean).join(', ')}]`;
      }
    }
    const line = `[${i}][${role}]: ${text}`;
    const lineTokens = estimateTextTokens(line);
    if (usedTokens + lineTokens > maxTokens) break;
    lines.push(line);
    usedTokens += lineTokens;
  }
  return lines.join('\n');
}

/**
 * LLM-powered message selector. Calls a sub-LLM to analyze the
 * message history and produce a keep/collapse plan — more surgical
 * than fixed-window rules.
 */
export class LLMSelector implements MessageSelector {
  private readonly provider: Provider;
  private readonly model: string;
  private readonly maxContextTokens: number;
  private readonly systemPrompt: string;
  private readonly maxOutputTokens: number;
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;

  constructor(opts: LLMSelectorOptions) {
    this.provider = opts.provider;
    this.model = opts.model ?? 'unknown';
    if (
      this.model === 'unknown' &&
      (process.env['NODE_ENV'] === 'development' || process.env['WRONGSTACK_DEBUG'] === '1')
    ) {
      console.warn(
        '[LLMSelector] model not set — selector will use the provider default. Set `model` explicitly in LLMSelectorOptions to silence this warning.',
      );
    }
    this.maxContextTokens = opts.maxContextTokens ?? 40_000;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxOutputTokens = opts.maxOutputTokens ?? 1024;
    this.oneShotOrchestrator = opts.oneShotOrchestrator;
  }

  async select(messages: Message[], maxToKeep: number): Promise<SelectorResult> {
    const effectiveBudget = Math.min(maxToKeep, this.maxContextTokens);

    const totalTokens = estimateMessageTokens(messages);
    const systemText = `${this.systemPrompt}\n\nConversation (${messages.length} messages, ~${totalTokens} tokens, budget: ${effectiveBudget}):\n`;
    // Reserve tokens for the system prefix and output (maxOutputTokens), then give the
    // rest to the formatted history so the selector sees the maximum possible context.
    const systemTokens = estimateTextTokens(systemText);
    const historyBudget = Math.max(512, effectiveBudget - systemTokens - this.maxOutputTokens);

    // Build a concise representation of the conversation within the token budget
    const historyText = formatMessages(messages, historyBudget);

    // Add instruction to stay within budget
    const budgetInstruction =
      totalTokens > effectiveBudget
        ? `\n\nIMPORTANT: Total conversation (${totalTokens} tokens) exceeds budget (${effectiveBudget}). You MUST collapse enough to fit. Prefer collapsing older/lower-importance ranges.`
        : '';

    const req: Request = {
      model: this.model,
      system: [{ type: 'text', text: systemText + budgetInstruction }],
      messages: [{ role: 'user', content: historyText }],
      maxTokens: this.maxOutputTokens,
    };

    let raw: string;
    const ac = new AbortController();
    try {
      if (this.oneShotOrchestrator) {
        const result = await this.oneShotOrchestrator.call({
          system: systemText + budgetInstruction,
          userPrompt: historyText,
          maxTokens: this.maxOutputTokens,
          timeoutMs: 30_000,
        });
        if (result.error) throw new Error(result.error);
        raw = result.text;
      } else {
        // 30-second timeout so a stuck selector LLM call can't hang the compactor.
        const timeoutSignal = AbortSignal.timeout(30_000);
        const res = await this.provider.complete(req, {
          signal: AbortSignal.any([ac.signal, timeoutSignal]),
        });
        const textBlocks = res.content.filter(isTextBlock);
        raw = textBlocks
          .map((b) => b.text)
          .join('\n')
          .trim();
      }
    } catch (err) {
      if (err instanceof Error) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'llm_selector.call_failed',
            message: `selector call failed, using recency fallback: ${err.message}`,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return this.fallbackSelect(messages, effectiveBudget);
    } finally {
      ac.abort();
    }

    return this.parseSelectorOutput(raw, messages);
  }

  private fallbackSelect(messages: Message[], budget: number): SelectorResult {
    // Simple fallback: keep from the end until we hit budget
    const toKeep: SelectorResult['kept'] = [];
    const toCollapse: SelectorResult['collapsed'] = [];

    let tokenCount = 0;
    let startIdx = 0;

    // Scan from the end backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = expectDefined(messages[i]);
      const cost = estimateMessageTokens([m]);

      if (tokenCount + cost <= budget) {
        tokenCount += cost;
      } else {
        startIdx = i + 1;
        break;
      }
    }

    if (startIdx > 0) {
      toCollapse.push({ from: 0, to: startIdx - 1 });
    }
    toKeep.push({ from: startIdx, to: messages.length - 1, importance: 'high' });

    return {
      kept: toKeep,
      collapsed: toCollapse,
      reasoning: `Fallback: kept last ${messages.length - startIdx} messages within ${budget} token budget`,
    };
  }

  /**
   * Parse and validate the raw LLM output into a SelectorResult.
   * Falls back to recency-based selection if the LLM output is malformed,
   * out-of-bounds, or internally inconsistent.
   */
  private parseSelectorOutput(raw: string, messages: Message[]): SelectorResult {
    const messageCount = messages.length;
    if (messageCount === 0) {
      return { kept: [], collapsed: [], reasoning: 'empty session' };
    }

    // Try to extract JSON from the response
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return this.fallbackSelect(messages, this.maxContextTokens);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return this.fallbackSelect(messages, this.maxContextTokens);
    }

    const obj = parsed as Record<string, unknown>;
    const keptRaw =
      (obj.kept as Array<{ from: number; to: number; importance: string }> | undefined) ?? [];
    const collapsedRaw =
      (obj.collapsed as Array<{ from: number; to: number; summary?: string | undefined }> | undefined) ?? [];

    // Validate kept ranges — must be within [0, messageCount), from <= to
    const kept: SelectorResult['kept'] = [];
    for (const k of keptRaw) {
      if (
        typeof k.from !== 'number' ||
        typeof k.to !== 'number' ||
        k.from < 0 ||
        k.to >= messageCount ||
        k.from > k.to
      ) {
        return this.fallbackSelect(messages, this.maxContextTokens);
      }
      kept.push({
        from: k.from,
        to: k.to,
        importance: (k.importance ?? 'medium') as 'critical' | 'high' | 'medium',
      });
    }

    // Validate collapsed ranges — same bounds check
    const collapsed: SelectorResult['collapsed'] = [];
    for (const c of collapsedRaw) {
      if (
        typeof c.from !== 'number' ||
        typeof c.to !== 'number' ||
        c.from < 0 ||
        c.to >= messageCount ||
        c.from > c.to
      ) {
        return this.fallbackSelect(messages, this.maxContextTokens);
      }
      collapsed.push({ from: c.from, to: c.to, summary: c.summary });
    }

    // Check for overlaps: kept ranges must not overlap with each other or with collapsed ranges
    const allRanges: Array<{ from: number; to: number }> = [...kept, ...collapsed];
    for (let i = 0; i < allRanges.length; i++) {
      const a = allRanges[i];
      if (!a) continue;
      for (let j = i + 1; j < allRanges.length; j++) {
        const b = allRanges[j];
        if (!b) continue;
        // Overlap: a starts before b ends AND a ends after b starts
        if (a.from <= b.to && a.to >= b.from) {
          return this.fallbackSelect(messages, this.maxContextTokens);
        }
      }
    }

    return {
      kept,
      collapsed,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    };
  }
}
