/**
 * Normalized phrases that mean "just keep going" on their own. Matching is
 * deliberately exact so substantive prompts such as "continue with auth"
 * remain ordinary user instructions.
 */
const CONTINUE_PHRASES: ReadonlySet<string> = new Set([
  'continue',
  'cont',
  'continue continue',
  'continue working',
  'keep going',
  'keep it going',
  'keep going on',
  'keep working',
  'keep on',
  'carry on',
  'go on',
  'goon',
  'go ahead',
  'proceed',
  'proceed further',
  'onward',
  'onwards',
  'next',
  'next step',
  'more',
  'resume',
  'and continue',
  'yes continue',
  'ok continue',
  'devam',
  'devam et',
  'devam et bakalim',
  'devam edelim',
  'devam edin',
  'devam etsene',
  'devam etsenize',
  'devam ediyoruz',
  'devam et lutfen',
  'surdur',
  'devam etsen',
  'devam et hadi',
  'hadi devam',
  'bir tur daha',
  'bir tur daha at',
  'bir tur daha bakalim',
  'bir tur daha atalim',
  'bir tur daha at bakalim',
  'weiter',
  'mach weiter',
  'continuar',
  'continua',
  'continuer',
  'continue por favor',
]);

/**
 * Word cap for the cheap pre-match guard, derived from the phrase set so that
 * no listed phrase (e.g. the five-word "bir tur daha at bakalim") can fall
 * outside it. A fixed cap smaller than the longest phrase made it unreachable.
 */
const MAX_CONTINUE_WORDS = Math.max(
  ...Array.from(CONTINUE_PHRASES, (phrase) => phrase.split(' ').length),
);

/**
 * Filler tokens that carry no instruction of their own. They are noise at
 * either end of the phrase, so both positions are stripped (see
 * {@link normalizeContinueInput}).
 */
const POLITENESS_TOKENS: readonly string[] = [
  'please',
  'pls',
  'plz',
  'lutfen',
  'thanks',
  'thank you',
  'thx',
  'ty',
];

function foldDiacritics(text: string): string {
  return text
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u');
}

function normalizeContinueInput(raw: string): string {
  // 'İ' first: its default lowercase is 'i' + U+0307, which the fold misses.
  let normalized = foldDiacritics(raw.trim().replace(/İ/g, 'i').toLowerCase());
  normalized = normalized.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  normalized = normalized.replace(/^[\s.!?,;:…]+/, '').replace(/[\s.!?,;:…]+$/, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  // Politeness is filler wherever it sits, so strip it from either end, then
  // again, until nothing changes: `please continue thanks` has to collapse to
  // the bare phrase `continue`. A token is only removed at a word boundary and
  // never when it IS the whole input, so bare politeness (`please`) stays a
  // non-match instead of becoming an empty string, and a substantive prompt
  // (`please continue with the auth refactor`) survives stripping only to be
  // rejected by the exact-phrase match below.
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of POLITENESS_TOKENS) {
      if (normalized.endsWith(` ${token}`)) {
        normalized = normalized.slice(0, -(token.length + 1)).trim();
        changed = true;
      } else if (normalized.startsWith(`${token} `)) {
        normalized = normalized.slice(token.length + 1).trim();
        changed = true;
      }
    }
  }
  return normalized;
}

/** True only when the entire input is a bare continuation nudge. */
export function detectContinueIntent(raw: string): boolean {
  if (!raw || raw.length > 40) return false;
  const normalized = normalizeContinueInput(raw);
  if (!normalized || normalized.split(' ').length > MAX_CONTINUE_WORDS) return false;
  return CONTINUE_PHRASES.has(normalized);
}
