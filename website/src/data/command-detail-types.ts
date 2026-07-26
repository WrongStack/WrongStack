export interface CommandDetail {
  /** One-sentence purpose — what problem this command solves. */
  purpose: string;
  /** 2–3 sentence description of how the command behaves when invoked. */
  behavior: string;
  /** What to check or confirm before running this command. */
  before: string;
  /** What you observe while the command executes. */
  during: string;
  /** What to verify or do after the command completes. */
  after: string;
}

/**
 * Single source of truth for the canonical surface enumeration.
 * Keep this list aligned with the six surfaces in the `surfaces` array
 * exported from `website/src/data/content.ts` and the homepage copy.
 * Each detail entry interpolates {@link surfaceListSentence} instead of
 * re-typing the list, so a new surface ships by adding it here once.
 */
export const surfaceListSentence = 'CLI, TUI, WebUI, SimpleUI, Desktop and HQ';

export type CommandDetailMap = Record<string, CommandDetail>;
