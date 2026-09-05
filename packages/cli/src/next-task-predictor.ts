/**
 * Next-task prediction — a lightweight, single-shot LLM call that guesses the
 * user's most likely next steps after an agent turn completes.
 *
 * Unlike `/autonomy suggest` (which replays a full `agent.run` with every tool
 * available), this issues ONE direct `provider.complete` with a tiny prompt and
 * a low token cap. No tools, no context replay — cheap and fast. It mirrors the
 * one-shot pattern used by `generateCommitMessageWithLLM` and `dispatch-llm`.
 *
 * The result is display-only: predictions are shown to the user, never executed.
 */

import type { TodoItem } from '@wrongstack/core/agent';
import { readBundledInstructionText } from '@wrongstack/core/utils';
import type { CommitLLMProvider } from './services/commit-message.js';

/** Provider shape required to predict — same structural contract as commit-llm. */
export type PredictLLMProvider = CommitLLMProvider;

interface PredictionInput {
  /** The user's request that kicked off the turn we just finished. */
  userRequest: string;
  /** The agent's final assistant text for the turn (its summary of what it did). */
  assistantSummary: string;
  /** The current live todo list, used as a strong signal for what's left. */
  todos: readonly TodoItem[];
}

interface PredictOpts {
  provider: PredictLLMProvider;
  model: string;
  /** Max predictions to return. Default 3. */
  maxPredictions?: number | undefined;
  /** Abort signal — when omitted, an internal 12s timeout is used. */
  signal?: AbortSignal | undefined;
}

const SYSTEM_PROMPT = readBundledInstructionText('cli/next-task-predictor.md');

const MAX_REQUEST_CHARS = 1200;
const MAX_SUMMARY_CHARS = 1200;

/** Clamp a string to `n` chars, appending an ellipsis when truncated. */
function clamp(text: string, n: number): string {
  const t = text.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** Build the user-message text from the turn context. Pure + testable. */
export function buildPredictionPrompt(input: PredictionInput): string {
  const parts: string[] = [];
  parts.push(`The user asked:\n${clamp(input.userRequest, MAX_REQUEST_CHARS) || '(no text)'}`);
  if (input.assistantSummary.trim()) {
    parts.push(
      `The assistant just finished and reported:\n${clamp(input.assistantSummary, MAX_SUMMARY_CHARS)}`,
    );
  }
  const pending = input.todos.filter((t) => t.status !== 'completed');
  if (pending.length > 0) {
    const list = pending
      .slice(0, 8)
      .map((t) => `- [${t.status}] ${t.content}`)
      .join('\n');
    parts.push(`Open todo items:\n${list}`);
  }
  parts.push(
    'Predict the 1-3 most likely exact prompt messages the user could submit back to the agent through the TUI or WebUI. Each must ask the agent to perform the work, never assign a manual chore to the user.',
  );
  return parts.join('\n\n');
}

/**
 * Parse a numbered/bulleted list of predictions out of raw model text.
 * Pure + testable. Returns [] for the NONE sentinel or unparseable output.
 */
export function parsePredictions(raw: string, max = 3): string[] {
  const text = raw.trim();
  if (!text) return [];
  // Sentinel: the model says there's nothing meaningful left. The match must
  // be against the WHOLE response, not a bare substring — a real list whose
  // first item happens to start with "none" (e.g. "None — here's the plan:")
  // or mention "no further steps" was being discarded in full.
  if (/^none\.?\s*$/i.test(text) || /^no further steps/i.test(text)) return [];

  const out: string[] = [];
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    // Strip a leading "1.", "2)", "-", "*", "•" marker if present.
    const stripped = line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim();
    const candidate = stripped || line;
    // Skip a stray "NONE" that slipped into a list.
    if (/^none$/i.test(candidate)) continue;
    if (candidate) out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
}

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return (content[0] as { text?: string | undefined } | undefined)?.text ?? '';
  }
  if (content && typeof content === 'object') {
    return (content as { text?: string | undefined }).text ?? '';
  }
  return typeof content === 'string' ? content : '';
}

/**
 * Predict the user's likely next steps. Best-effort: any failure (timeout,
 * provider error, abort) resolves to `[]` so the caller can stay silent and
 * never let prediction break the turn.
 */
export async function predictNextTasks(
  input: PredictionInput,
  opts: PredictOpts,
): Promise<string[]> {
  const max = opts.maxPredictions ?? 3;
  const internal = new AbortController();
  const timeout = setTimeout(() => internal.abort(), 12_000);
  const onParentAbort = () => internal.abort();
  if (opts.signal) {
    if (opts.signal.aborted) internal.abort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const resp = await opts.provider.complete(
      {
        model: opts.model,
        system: [{ type: 'text', text: SYSTEM_PROMPT }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: buildPredictionPrompt(input) }] },
        ],
        maxTokens: 160,
        temperature: 0.3,
      },
      { signal: internal.signal },
    );
    return parsePredictions(extractText(resp.content), max);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
  }
}
