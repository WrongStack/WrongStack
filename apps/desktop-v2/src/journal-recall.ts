import { entries } from './engine-values';

/** Journal prompts loaded for up-arrow recall. */
export const RECALL_JOURNAL_LIMIT = 50;

/** Original prompts from a `prompts.journal` reply, newest first. */
export function journalRecallTexts(result: unknown): string[] {
  return entries((result as Record<string, unknown> | undefined)?.['entries'])
    .filter((row) => row['category'] === 'raw_user' && typeof row['content'] === 'string')
    .sort((a, b) => String(b['timestamp']).localeCompare(String(a['timestamp'])))
    .map((row) => String(row['content']));
}

/** Recall order: this conversation's prompts (newest first), then older journal prompts. */
export function recallHistory(
  conversation: readonly string[],
  journal: readonly string[],
  limit = 100,
): string[] {
  return [
    ...new Set(
      [...[...conversation].reverse(), ...journal].filter((text) => text.trim().length > 0),
    ),
  ].slice(0, limit);
}
