// PR 3 of Issue #30 (webui-server 8-PR refactor):
// per-section token breakdown, glued from the standalone
// webui's token-estimator primitives.
//
// Why this split:
//
//   - `estimateContextBreakdown` consumes three
//     `estimateTokens` / `messageTokens` /
//     `messagePreview` primitives that already live in
//     `@wrongstack/webui/server`. The function is the
//     "shape stitching" — the report structure that says
//     "system prompt + tool schemas + message history = X
//     tokens". The underlying math is the standalone
//     package's job; the *report* is the CLI's.
//
//   - Lifting it out of `webui-server.ts` makes the
//     dependency direction explicit: this file imports
//     from `@wrongstack/webui/server` (the source of
//     truth for token math), and nothing imports from
//     this file except the CLI's own WS handler that
//     serves the `context.breakdown` message. That's
//     a one-way data flow with no possibility of
//     drift.
//
//   - `webui-server.ts` loses 30 lines of arithmetic
//     and gains a 4-line import. The report shape is
//     now testable in isolation: pin the system/tool/
//     message sum, pin the per-tool breakdown shape,
//     pin the per-message preview pinning.
//
// What is *not* in this file:
//
//   - The token math itself. That is the standalone
//     webui's job. The plan body of Issue #30 calls
//     this layering out: "the two implementations are
//     no longer drifting apart — they're correctly
//     layered." This file is the seam.

import {
  estimateTokens,
  messagePreview,
  messageTokens,
  stringifyContent,
} from '@wrongstack/webui/server';

interface PromptBlock {
  text?: string | undefined;
}

interface ToolLike {
  name: string;
  inputSchema?: unknown;
  description?: string;
}

interface MessageLike {
  role: string;
  content: unknown;
}

// Re-exported so the call site (the WS `context.debug`
// handler in `webui-server.ts`) can cast the live agent
// state to the same shapes without re-declaring them.
// Pre-refactor, these interfaces were module-private to
// `webui-server.ts`; after PR 3 they are owned by this
// module and re-imported where needed.
export type { PromptBlock, ToolLike, MessageLike };

/**
 * Compute the per-section token breakdown for a session.
 *
 * The shape is preserved exactly as the pre-refactor inline
 * code produced it: `total` is the sum across sections;
 * `systemPrompt` is its own total (no breakdown — the
 * system prompt is opaque); `tools` carries the count and
 * a per-tool token count; `messages` carries the count, the
 * total, and a per-message `{ index, role, tokens, preview }`
 * row.
 *
 * Empty inputs are valid: the totals come out to 0 and the
 * `breakdown` arrays are empty. The pre-refactor code
 * handled this implicitly (the `.reduce` over an empty
 * array returns 0); the extracted helper pins that
 * behavior with explicit tests.
 */
export function estimateContextBreakdown(input: {
  systemPrompt: ReadonlyArray<PromptBlock>;
  tools: ReadonlyArray<ToolLike>;
  messages: ReadonlyArray<MessageLike>;
}): {
  total: number;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
} {
  const sysTokens = input.systemPrompt.reduce((acc, b) => acc + estimateTokens(b.text ?? ''), 0);
  const toolBreakdown = input.tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const desc = t.description ?? '';
    return {
      name: t.name,
      tokens:
        estimateTokens(t.name) + estimateTokens(desc) + estimateTokens(stringifyContent(schema)),
    };
  });
  const toolTokens = toolBreakdown.reduce((a, b) => a + b.tokens, 0);
  const messageBreakdown = input.messages.map((m, i) => ({
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
