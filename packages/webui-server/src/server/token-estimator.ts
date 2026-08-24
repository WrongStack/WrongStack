/**
 * Per-section context-window token estimate for the `context.debug` command.
 *
 * Since card #5 (slice 5g) this module delegates the actual token math to
 * the canonical calibrated estimator in `@wrongstack/core/utils`
 * (3.5 chars/token basis + per-model-family EWM calibration — see
 * `core/src/utils/token-estimate.ts`). Before this, the WebUI computed a
 * private 4-chars/token estimate, so the number in the browser's context
 * debug view diverged from what compaction and the TUI context bar were
 * actually deciding on (~14% for typical mixed content). Delegating means
 * the user sees the same number the system acts on.
 *
 * User-visible shift (intentional): all token figures shown by the WebUI
 * context breakdown now match the CLI/TUI estimator — mixed-content
 * conversations read ~14% HIGHER than the old 4-chars/token figures
 * (3.5 chars/token is a more conservative, over-estimating basis by
 * design, so compaction triggers are consistent rather than optimistic).
 * Previews, block walking, and the `ContextBreakdown` shape are unchanged.
 *
 * `stringifyContent` stays local: its circular-reference fallback and the
 * duck-typed block walk below are presentation-side concerns the canonical
 * estimator does not share (it walks typed `Message` content).
 */

import {
  estimateTextTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '@wrongstack/core/utils';

/** Calibrated token estimate for a string — delegates to the shared basis. */
export function estimateTokens(s: string): number {
  return s.length === 0 ? 0 : estimateTextTokens(s);
}

/** Stringify arbitrary content for length estimation (JSON, with fallbacks). */
export function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    const serialized = JSON.stringify(c);
    // JSON.stringify returns `undefined` (not a string) for top-level
    // undefined/function/symbol values WITHOUT throwing, so the catch
    // below would never run and the declared `string` contract would be
    // violated — callers feeding the result into estimateTokens(s) then
    // crashed on `s.length`. Route that case to the same String(c) fallback.
    return serialized === undefined ? String(c) : serialized;
  } catch {
    return String(c);
  }
}

interface PromptBlock {
  text?: string | undefined;
}
interface ToolLike {
  name: string;
  inputSchema?: unknown | undefined;
  description?: string | undefined;
}
interface ContentBlock {
  type?: string | undefined;
  text?: string | undefined;
  input?: unknown | undefined;
  content?: unknown | undefined;
  name?: string | undefined;
}
interface MessageLike {
  role: string;
  content: unknown;
}

export interface ToolTokenEntry {
  name: string;
  tokens: number;
}
export interface MessageTokenEntry {
  index: number;
  role: string;
  tokens: number;
  preview: string;
}

export interface ContextBreakdown {
  total: number;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: ToolTokenEntry[] };
  messages: { total: number; count: number; breakdown: MessageTokenEntry[] };
}

export function messageTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let tk = 0;
  for (const b of content as ContentBlock[]) {
    if (b.type === 'text') tk += estimateTokens(b.text ?? '');
    else if (b.type === 'tool_use') tk += estimateToolInputTokens(b.input);
    else if (b.type === 'tool_result') tk += estimateToolResultTokens(b.content);
    else tk += estimateTokens(stringifyContent(b));
  }
  return tk;
}

export function messagePreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 60);
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .map((b) =>
      b.type === 'text'
        ? (b.text ?? '').slice(0, 40)
        : b.type === 'tool_use'
          ? `[tool_use: ${b.name}]`
          : b.type === 'tool_result'
            ? '[tool_result]'
            : `[${b.type}]`,
    )
    .join(' ')
    .slice(0, 60);
}

/**
 * Compute the per-section token breakdown for the active context. Mirrors the
 * shape the `context.debug` WS reply expects (minus the `mode`/`policy` fields,
 * which the caller layers on from `context.meta`).
 */
export function estimateContextBreakdown(input: {
  systemPrompt: ReadonlyArray<PromptBlock>;
  tools: ReadonlyArray<ToolLike>;
  messages: ReadonlyArray<MessageLike>;
}): ContextBreakdown {
  const sysTokens = input.systemPrompt.reduce((acc, b) => acc + estimateTokens(b.text ?? ''), 0);

  const toolBreakdown: ToolTokenEntry[] = input.tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const desc = t.description ?? '';
    return {
      name: t.name,
      tokens:
        estimateTokens(t.name) + estimateTokens(desc) + estimateTokens(stringifyContent(schema)),
    };
  });
  const toolTokens = toolBreakdown.reduce((a, b) => a + b.tokens, 0);

  const messageBreakdown: MessageTokenEntry[] = input.messages.map((m, i) => ({
    index: i,
    role: m.role,
    tokens: messageTokens(m.content),
    preview: messagePreview(m.content),
  }));
  const msgTokens = messageBreakdown.reduce((a, b) => a + b.tokens, 0);

  return {
    total: sysTokens + toolTokens + msgTokens,
    systemPrompt: sysTokens,
    tools: { total: toolTokens, count: input.tools.length, breakdown: toolBreakdown },
    messages: { total: msgTokens, count: input.messages.length, breakdown: messageBreakdown },
  };
}
