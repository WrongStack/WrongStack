import type { TodoItem } from '@wrongstack/core/agent';

import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import { parseSuggestionsFromOutput } from './repl.js';
import { setSuggestions } from './services/suggestion-store.js';

export function createTuiNextStepCallbacks(input: {
  context: {
    todos?: readonly TodoItem[] | null | undefined;
    provider: unknown;
    model: string;
  };
  getNextPredict?: (() => boolean) | undefined;
  getAutonomy?: (() => string) | undefined;
  getSuggestions?: (() => string[]) | undefined;
}): {
  predictNext(input: { userRequest: string; assistantSummary: string }): Promise<string[]>;
  onSuggestionsParsed(finalText: string): void;
  getSuggestions(): string[];
  setSuggestions(suggestions: string[]): void;
} {
  const { context, getNextPredict, getAutonomy, getSuggestions } = input;
  return {
    async predictNext(request: { userRequest: string; assistantSummary: string }) {
      if (!getNextPredict?.()) return [];
      if ((getAutonomy?.() ?? 'off') !== 'off') return [];
      return predictNextTasks(
        { ...request, todos: context.todos ?? [] },
        {
          provider: context.provider as PredictLLMProvider,
          model: context.model,
        },
      );
    },
    onSuggestionsParsed(finalText: string) {
      const parsed = parseSuggestionsFromOutput(finalText, context.todos);
      setSuggestions(parsed ?? []);
    },
    getSuggestions: () => getSuggestions?.() ?? [],
    setSuggestions,
  };
}
