import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Action } from './app-action-type.js';
import { MAX_CHAT_SEARCH_QUERY_CHARS } from './input-validation/limits.js';

interface ChatSearchSlashDeps {
  dispatch: (action: Action) => void;
  /** Thinking cards are only searchable while model reasoning is shown. */
  includeReasoning: () => boolean;
}

/**
 * TUI `/chat-search [text]` — opens the transcript search bar (same as
 * Alt+F), optionally prefilled. Searches the history retained in this TUI;
 * entries evicted by history retention are not searched.
 */
export function createChatSearchSlashCommand(deps: ChatSearchSlashDeps): SlashCommand {
  return {
    name: 'chat-search',
    description:
      'Search the chat transcript on screen (Alt+F). ↑/Enter older · ↓ newer · Esc close.',
    argsHint: '[text]',
    category: 'Inspect',
    help:
      'Usage:\n' +
      '  /chat-search          — open the transcript search bar (same as Alt+F)\n' +
      '  /chat-search <text>   — open it and jump to the newest match for <text>\n\n' +
      'Keys while open: type to search · ↑/Enter older match · ↓ newer match ·\n' +
      'Ctrl+U clear · Esc close. Lowercase text matches any case; any capital\n' +
      'letter makes the search case-sensitive. Only history retained in this\n' +
      'TUI is searched.\n',
    async run(args: string) {
      const query = args.trim().slice(0, MAX_CHAT_SEARCH_QUERY_CHARS);
      deps.dispatch({
        type: 'chatSearchOpen',
        ...(query ? { query } : {}),
        includeReasoning: deps.includeReasoning(),
      });
      return { message: '' };
    },
  };
}
