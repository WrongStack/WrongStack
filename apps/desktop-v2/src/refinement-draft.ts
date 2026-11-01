import type { SubmitMode } from './composer-model';
import type { FormDraftCodec } from './durable-form-draft';

export type RefinementVariant = 'original' | 'refined' | 'english';

/**
 * A refinement waiting for review: the request, the reply and the reviewer's edits. While the
 * refiner is still working there is no reply yet (`result` null, `pending` set), so a restart
 * can offer to run the same request again instead of losing it.
 */
export interface RefinementDraft {
  original: string;
  mode: SubmitMode;
  draftAtOpen: string;
  freshContext: boolean;
  result: {
    refined: string;
    english?: string;
    refinedWith?: { provider: string; model: string };
  } | null;
  pending?: true;
  variant: RefinementVariant;
  edited: string | null;
  savedAt: number;
}

const MAX_TEXT = 1_000_000;
const text = (value: unknown, allowEmpty = true) =>
  typeof value === 'string' && value.length <= MAX_TEXT && (allowEmpty || value.trim() !== '');

/**
 * Keeps only what review needs from the engine reply, so a restored preview shows exactly the
 * text and provenance the refiner returned; anything else in the reply is not persisted.
 */
export function refinementDraftResult(
  reply: Record<string, unknown>,
): RefinementDraft['result'] | null {
  if (!text(reply['refined'], false)) return null;
  const by = reply['refinedWith'] as Record<string, unknown> | undefined;
  return {
    refined: reply['refined'] as string,
    ...(text(reply['english'], false) ? { english: reply['english'] as string } : {}),
    ...(by && typeof by['provider'] === 'string' && typeof by['model'] === 'string'
      ? { refinedWith: { provider: by['provider'], model: by['model'] } }
      : {}),
  };
}

export const refinementDraftCodec: FormDraftCodec<RefinementDraft> = {
  serialize: (draft) => ({ version: 1, ...draft }),
  parse: (value) => {
    if (value === null) return null;
    const saved = value as Record<string, unknown>;
    const pending = !!saved && typeof saved === 'object' && saved['pending'] === true;
    const result =
      saved && typeof saved === 'object' && !(pending && saved['result'] === null)
        ? refinementDraftResult((saved['result'] ?? {}) as Record<string, unknown>)
        : null;
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      saved['version'] !== 1 ||
      !text(saved['original'], false) ||
      !['btw', 'queue', 'steer'].includes(saved['mode'] as string) ||
      !text(saved['draftAtOpen']) ||
      typeof saved['freshContext'] !== 'boolean' ||
      (!result && !pending) ||
      !['original', 'refined', 'english'].includes(saved['variant'] as string) ||
      (saved['variant'] === 'english' && !result?.english) ||
      !(saved['edited'] === null || text(saved['edited'])) ||
      typeof saved['savedAt'] !== 'number'
    )
      throw Error('The saved refinement review has an unsupported format.');
    return {
      original: saved['original'] as string,
      mode: saved['mode'] as SubmitMode,
      draftAtOpen: saved['draftAtOpen'] as string,
      freshContext: saved['freshContext'] as boolean,
      result,
      ...(pending && !result ? { pending: true as const } : {}),
      variant: saved['variant'] as RefinementVariant,
      edited: saved['edited'] as string | null,
      savedAt: saved['savedAt'] as number,
    };
  },
};
