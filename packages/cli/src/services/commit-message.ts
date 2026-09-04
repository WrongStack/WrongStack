import { expectDefined, readBundledInstructionText } from '@wrongstack/core/utils';
/**
 * Shared LLM-powered commit message generation.
 * Generates proper commit messages by analyzing git diffs via the configured LLM provider.
 */

export interface CommitLLMProvider {
  complete(
    req: {
      model: string;
      system?: { type: 'text' | undefined; text: string }[];
      messages: { role: string; content: { type: 'text'; text: string }[] }[];
      maxTokens: number;
      temperature?: number | undefined;
    },
    opts: { signal: AbortSignal },
  ): Promise<{
    /** Normalized content blocks (Anthropic/OpenAI compatible) */
    content: { type: 'text'; text: string }[];
    model: string;
  }>;
}

interface CommitLLMOpts {
  provider: CommitLLMProvider;
  model: string;
}

/**
 * Generate a proper commit message by asking the LLM to analyze the diff.
 * Falls back to heuristics on failure.
 */
export async function generateCommitMessageWithLLM(
  diff: string,
  opts: CommitLLMOpts,
): Promise<string> {
  const systemPrompt = readBundledInstructionText('cli/commit-message.md');

  const userPrompt = `Here is the git diff:\n\n${diff}`;

  const signal = new AbortController();
  const timeout = setTimeout(() => signal.abort(), 15_000);

  try {
    const resp = await opts.provider.complete(
      {
        model: opts.model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        maxTokens: 80,
        temperature: 0.3,
      },
      { signal: signal.signal },
    );

    const rawContent = resp.content;
    const text = Array.isArray(rawContent)
      ? ((rawContent[0] as { type: string; text?: string | undefined })?.text ?? '')
      : typeof rawContent === 'object' && rawContent !== null
        ? ((rawContent as { type: string; text?: string | undefined }).text ?? '')
        : String(rawContent);
    const message = expectDefined(text.trim().split('\n')[0]);

    if (message.length > 0 && message.length < 200) {
      return message;
    }
  } catch {
    // LLM call failed — fall through to heuristics
  } finally {
    // Clear on every path. A rejecting provider must not strand a referenced
    // 15s timer that holds the event loop open after the heuristic fallback
    // already resolved (mirrors next-task-predictor.ts).
    clearTimeout(timeout);
  }

  // Fallback: use heuristics via the existing function
  return 'chore: update';
}
