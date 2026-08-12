import type { TodoItem } from '@wrongstack/core/agent';
import { hasOpenTodos } from '@wrongstack/core/utils';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import { setAutoSuggestions } from './services/suggestion-store.js';

/**
 * Extract canonical "<nextsteps>" suggestions from the agent's final output.
 * Loose "Next steps" prose is intentionally ignored; `/next` requires the tagged block.
 * Returns null when no suggestions are found.
 *
 * Gated on the live todo list: when the agent still has open todos
 * (`pending` or `in_progress`), we suppress `<nextsteps>` entirely and clear
 * the auto-suggestion store. Surfacing suggestions mid-task would race the
 * todo loop — YOLO+auto could pick the top suggestion and pivot away from
 * the unfinished work, and `/next 1` would replace the next todo with an
 * arbitrary prompt. Finishing the todo list comes first; suggestions re-arm
 * on the next turn once everything is `completed`.
 */
export function parseSuggestionsFromOutput(
  finalText: string,
  todos?: readonly TodoItem[] | null,
): string[] | null {
  if (hasOpenTodos(todos)) {
    // Clear auto-suggestion store too; stale auto="true" items would otherwise
    // survive into the next turn after regular suggestions were suppressed.
    setAutoSuggestions([]);
    return null;
  }
  const { texts, autoTexts } = parseNextSteps(finalText);
  if (autoTexts.length > 0) {
    setAutoSuggestions(autoTexts);
  }
  return texts.length > 0 ? texts : null;
}

/**
 * Extract only the auto="true" items from next_steps output.
 * Used by YOLO+auto autonomy mode.
 */
export function parseAutoSuggestionsFromOutput(finalText: string): string[] | null {
  const { autoTexts } = parseNextSteps(finalText);
  return autoTexts.length > 0 ? autoTexts : null;
}
