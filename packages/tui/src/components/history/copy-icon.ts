import type { HistoryEntry } from '../../history-entry.js';

/**
 * Glyph rendered as the clickable copy affordance on copyable chat cards.
 * Chosen from the Dingbats range (U+274F), which the TUI's tool-glyph table
 * already relies on for guaranteed single-cell monospace width — East-Asian
 * "ambiguous width" glyphs would desync the icon column the hit test records.
 */
export const COPY_ICON = '❏';

/**
 * Width in terminal cells the copy icon occupies when rendered. The hit test in
 * the mouse handler treats the icon column plus this span as the target.
 */
export const COPY_ICON_WIDTH = 1;

/**
 * Return the plain text that clicking a card's copy icon should place on the
 * clipboard, or `null` when the entry is not copyable.
 *
 * Only the text-bearing conversational cards are copyable: the user's prompt
 * (its full paste content when the visible text is a placeholder), the
 * assistant's reply, and thinking output. Tool cards, banners, status lines and
 * other chrome return `null`, so no copy icon is drawn for them.
 */
export function copyableTextForEntry(entry: HistoryEntry): string | null {
  switch (entry.kind) {
    case 'user': {
      // A pasted block is shown collapsed; copy the full original content when
      // present, otherwise the visible text.
      const text = entry.pasteContent && entry.pasteContent.length > 0 ? entry.pasteContent : entry.text;
      return text.length > 0 ? text : null;
    }
    case 'assistant':
    case 'thinking':
      return entry.text.length > 0 ? entry.text : null;
    default:
      return null;
  }
}

/** True when the entry should render a clickable copy icon. */
export function isCopyableEntry(entry: HistoryEntry): boolean {
  return copyableTextForEntry(entry) !== null;
}
