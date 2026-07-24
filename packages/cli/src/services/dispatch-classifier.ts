/**
 * LLM-backed classifier for the smart agent dispatcher.
 *
 * Wraps the session provider in the `complete(prompt) => text` shape that
 * `makeLLMClassifier` expects, so `/fleet dispatch` can fall back to the model
 * when the heuristic router is ambiguous. Mirrors the one-shot completion
 * pattern used by `generateCommitMessageWithLLM`.
 */
import type { DispatchClassifier } from '@wrongstack/core/coordination';
import { makeLLMClassifier } from '@wrongstack/core/coordination';
import type { CommitLLMProvider } from './commit-message.js';

export function makeProviderClassifier(
  provider: CommitLLMProvider,
  model: string,
): DispatchClassifier {
  return makeLLMClassifier(async (prompt: string): Promise<string> => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await provider.complete(
        {
          model,
          system: [
            {
              type: 'text',
              text:
                'You are an agent router. Choose the single best agent for the task. ' +
                'Reply with ONLY a compact JSON object {"role":"...","reason":"..."}.',
            },
          ],
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: 120,
          temperature: 0,
        },
        { signal: ctrl.signal },
      );
      const content = resp.content;
      return Array.isArray(content) ? (content[0]?.text ?? '') : '';
    } catch {
      return '';
    } finally {
      clearTimeout(timeout);
    }
  });
}
