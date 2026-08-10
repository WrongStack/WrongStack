export const LEARNED_SOFT_LIMIT = 8_192;
export const LEARNED_HARD_LIMIT = 16_384;

/**
 * Maximum length (in characters) of a single captured learning entry after
 * normalization.
 */
export const LEARNED_ENTRY_MAX_CHARS = 600;

export const MIN_INSTRUCTIVE_LENGTH = 30;

/**
 * Category tag for a captured learning entry. Derived deterministically from
 * the entry's content so the file is self-describing and scannable.
 */
export type LearnedEntryCategory = 'convention' | 'pattern' | 'warning' | 'fact';

const NARRATIVE_SENTENCE_STARTS: readonly RegExp[] = [
  /^(?:when|while|during|after|before|once|since)\s+(?:i|we|the agent|i was|i were|i had)\b/i,
  /^(?:i|we)\s+(?:found|noticed|learned|discovered|realized|saw|encountered|hit|ran into)\b/i,
  /^(?:i|we)\s+(?:was|were|had|did|ran|tried|attempted|used|modified|changed|updated)\b/i,
  /^(?:this|that|the)\s+(?:task|session|run|commit|change|pr|pull request|invocation)\b/i,
  /^(?:in|on|for|at|during)\s+(?:this|that|the)\s+(?:task|session|run|commit|change|pr)\b/i,
  /^(?:today|yesterday|earlier|just now|recently|lately)\b/i,
];

const EPHEMERAL_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // Commit SHAs. A bare `[0-9a-f]{7,40}` also matches ordinary English words
  // spelled entirely from hex letters ("defaced", "acceded", "effaced"), so
  // require at least one digit — every real abbreviated SHA has one in
  // practice, and the false-positive class disappears.
  { pattern: /\b(?=[0-9a-f]{7,40}\b)[a-f]*\d[0-9a-f]*\b/g, replacement: '' },
  {
    pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: '',
  },
  {
    pattern: /(?<=\b(?:on|from|since|before|after|dated|until)\s)\d{4}-\d{2}-\d{2}\b/gi,
    replacement: '',
  },
  { pattern: /\b(?:line|lines?)\s+\d+(?:\s*[-–]\s*\d+)?/gi, replacement: '' },
  { pattern: /#\s*(?:PR|issue|MR)\s*\d+/gi, replacement: '' },
  { pattern: /(?<=\s)#\d{1,6}\b/g, replacement: '' },
];

/**
 * Normalize a captured LEARNED block into an instructive entry.
 */
export function normalizeLearnedEntry(raw: string): {
  text: string;
  category: LearnedEntryCategory;
} | null {
  if (!raw) return null;

  let cleaned = raw;
  for (const { pattern, replacement } of EPHEMERAL_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  const sentences = splitSentences(cleaned);
  const directiveSentences: string[] = [];
  let hadSubstantiveNarrative = false;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (isNarrativeSentence(trimmed)) {
      hadSubstantiveNarrative = true;
      const salvaged = salvageDirectiveTail(trimmed);
      if (salvaged) directiveSentences.push(salvaged);
      continue;
    }
    directiveSentences.push(trimmed);
  }

  if (directiveSentences.length === 0) return null;

  let normalized = directiveSentences.join(' ').replace(/\s+/g, ' ').trim();

  if (normalized.length > LEARNED_ENTRY_MAX_CHARS) {
    normalized = truncateToInstructive(normalized, LEARNED_ENTRY_MAX_CHARS);
    if (normalized.length < MIN_INSTRUCTIVE_LENGTH) return null;
  }

  if (normalized.length < MIN_INSTRUCTIVE_LENGTH) return null;

  if (hadSubstantiveNarrative && directiveSentences.length < sentences.length / 2) {
    if (normalized.length < MIN_INSTRUCTIVE_LENGTH * 2) return null;
  }

  return {
    text: normalized,
    category: classifyLearnedEntry(normalized),
  };
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNarrativeSentence(sentence: string): boolean {
  return NARRATIVE_SENTENCE_STARTS.some((re) => re.test(sentence));
}

function salvageDirectiveTail(sentence: string): string | null {
  for (const re of NARRATIVE_SENTENCE_STARTS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const tail = sentence
      .slice(m[0].length)
      .replace(/^[,\s]+/, '')
      .trim();
    if (!tail) return null;
    if (looksDirective(tail)) return tail;
    return null;
  }
  return null;
}

const DIRECTIVE_VERB_PATTERN =
  /^(?:always|never|prefer|avoid|use|ensure|verify|check|run|execute|apply|adopt|choose|require|must|should|don'?t|do not|keep|maintain|set|define|specify|validate|confirm|inspect|review|handle|enable|disable|restrict|cap|limit|wrap|isolate|separate|combine|split|merge|refactor|rename|move|extract|inline)\b/i;

function looksDirective(text: string): boolean {
  if (DIRECTIVE_VERB_PATTERN.test(text)) return true;
  if (/\b(?:is|are|must be|should be|required to)\s+(?:always|never|used|preferred)\b/i.test(text))
    return true;
  if (
    /\b(?:had to|has to|have to|needs? to|must|should|ought to)\s+\w+/i.test(text) &&
    text.length > MIN_INSTRUCTIVE_LENGTH
  )
    return true;
  return false;
}

function truncateToInstructive(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  let acc = '';
  for (const s of sentences) {
    const candidate = acc ? `${acc} ${s}` : s;
    if (candidate.length > maxChars) break;
    acc = candidate;
  }
  if (acc) return acc;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

export function classifyLearnedEntry(text: string): LearnedEntryCategory {
  const lower = text.toLowerCase();
  if (
    /\b(?:avoid|never|don'?t|do not|must not|prevent|watch out|beware|pitfall|gotcha|hazard|risk)\b/.test(
      lower,
    )
  )
    return 'warning';
  if (
    /\b(?:use|prefer|choose|adopt|leverage|apply|switch to|migrate to)\b/.test(lower) ||
    /\b(?:pattern|approach|strategy|technique|idiom)\b/.test(lower)
  )
    return 'pattern';
  if (
    /\b(?:always|must|should|require|ensure|verify|check|run|execute|before|after|when)\b/.test(
      lower,
    )
  )
    return 'convention';
  return 'fact';
}

export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
}
