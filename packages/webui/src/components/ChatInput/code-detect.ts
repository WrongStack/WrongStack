// ── Code language detection for paste auto-fencing ──────────────────
// Heuristic scoring: each language gets points for matching patterns.
// Highest score ≥ threshold → detected as code. Otherwise → prose.

interface LanguagePattern {
  lang: string;
  /** Score per match. Higher-weight patterns (distinctive keywords) score more. */
  patterns: Array<{ regex: RegExp; weight: number }>;
}

const LANG_PATTERNS: LanguagePattern[] = [
  {
    lang: 'typescript',
    patterns: [
      {
        regex: /:\s*(string|number|boolean|void|never|any|unknown|Promise|Array|Record|Map|Set)\b/,
        weight: 4,
      },
      {
        regex: /\b(interface|type|enum|namespace|implements|extends|as|satisfies|infer)\b/,
        weight: 3,
      },
      { regex: /\b(import|export)\s+/, weight: 3 },
      { regex: /\b(const|let|var)\s+\w+\s*[:=]/, weight: 2 },
      { regex: /=>/, weight: 1 },
      { regex: /\.tsx?['"]/, weight: 2 },
    ],
  },
  {
    lang: 'javascript',
    patterns: [
      { regex: /\b(import|export|require)\s*[({]/, weight: 3 },
      { regex: /\b(const|let|var)\s+\w+\s*=\s*require/, weight: 2 },
      { regex: /\bmodule\.exports/, weight: 3 },
      { regex: /\.jsx?['"]/, weight: 2 },
    ],
  },
  {
    lang: 'python',
    patterns: [
      { regex: /^\s*def\s+\w+\s*\(/, weight: 4 },
      { regex: /^\s*class\s+\w+.*:/, weight: 3 },
      { regex: /\bimport\s+\w+/, weight: 2 },
      { regex: /\bfrom\s+\w+\s+import/, weight: 3 },
      { regex: /\bprint\(/, weight: 1 },
      { regex: /\bself\./, weight: 2 },
      { regex: /if\s+__name__\s*==\s*['"]__main__['"]/, weight: 4 },
    ],
  },
  {
    lang: 'rust',
    patterns: [
      { regex: /\bfn\s+\w+\s*[<(]/, weight: 4 },
      { regex: /\blet\s+mut\s/, weight: 3 },
      { regex: /\b(struct|enum|impl|trait|mod)\s+\w+/, weight: 3 },
      { regex: /\bpub\s+(fn|struct|enum)/, weight: 3 },
      { regex: /->\s*\w+/, weight: 1 },
      { regex: /::\w+/, weight: 1 },
    ],
  },
  {
    lang: 'go',
    patterns: [
      { regex: /\bfunc\s+\w+\s*\(/, weight: 4 },
      { regex: /\bpackage\s+\w+/, weight: 4 },
      { regex: /\bimport\s*\(/, weight: 3 },
      { regex: /\b(err|nil)\b/, weight: 2 },
      { regex: /:=/, weight: 2 },
      { regex: /\bdefer\s/, weight: 2 },
    ],
  },
  {
    lang: 'json',
    patterns: [
      { regex: /^\s*[{[]/, weight: 3 },
      { regex: /"[^"]+"\s*:\s*/, weight: 3 },
      { regex: /^\s*[}\]]\s*$/, weight: 1 },
    ],
  },
  {
    lang: 'yaml',
    patterns: [
      { regex: /^---\s*$/, weight: 4 },
      { regex: /^\s*\w[\w.-]*:\s/, weight: 2 },
      { regex: /^\s*-\s+\w/, weight: 1 },
    ],
  },
  {
    lang: 'html',
    patterns: [
      { regex: /<(!DOCTYPE|html|head|body|div|span|a|p|ul|li|table)/i, weight: 4 },
      { regex: /<\/?\w+[\s>]/, weight: 2 },
      { regex: /\b(class|id|href|src)="/, weight: 2 },
    ],
  },
  {
    lang: 'css',
    patterns: [
      { regex: /[{]\s*$/, weight: 1 },
      { regex: /^\s*[.#@]\S+\s*[{]/, weight: 3 },
      { regex: /\b(\d+px|\d+em|\d+rem|\d+vh|\d+vw)\b/, weight: 3 },
      { regex: /:\s*\w+\s*!important/, weight: 3 },
      { regex: /@(media|keyframes|import|apply)/, weight: 3 },
    ],
  },
  {
    lang: 'sql',
    patterns: [
      {
        regex: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i,
        weight: 4,
      },
      { regex: /\bFROM\s+\w+/i, weight: 2 },
      { regex: /\bWHERE\s+/i, weight: 2 },
      { regex: /\b(JOIN|INNER JOIN|LEFT JOIN)\b/i, weight: 2 },
    ],
  },
  {
    lang: 'bash',
    patterns: [
      { regex: /^#!\/.*(bash|sh|zsh)/, weight: 5 },
      { regex: /\becho\s/, weight: 2 },
      { regex: /\bexport\s+\w+=/, weight: 2 },
      { regex: /\bif\s+\[\[?\s/, weight: 2 },
      { regex: /\$\{?\w+/, weight: 1 },
      { regex: /&&|\|\|/, weight: 1 },
    ],
  },
  {
    lang: 'toml',
    patterns: [
      { regex: /^\s*\[.*\]\s*$/, weight: 3 },
      { regex: /^\s*\w+\s*=\s*['"]/, weight: 2 },
      { regex: /^\s*\[\[.*\]\]\s*$/, weight: 3 },
    ],
  },
];

/** Minimum total score to consider text as "code" worth fencing. */
const CODE_THRESHOLD = 6;

/** Minimum number of lines for auto-fencing to activate. */
const MIN_CODE_LINES = 3;

/** Maximum line length to still qualify as code (prose has long lines). */
const MAX_CODE_LINE_LEN = 180;

/**
 * Heuristic: does this text "look like code" rather than prose?
 * Checks line count, line lengths, and presence of special characters.
 */
function looksLikeCode(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < MIN_CODE_LINES) return false;

  let codeIndicators = 0;
  let proseIndicators = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Very long lines → probably prose, not code
    if (trimmed.length > MAX_CODE_LINE_LEN) proseIndicators++;

    // Indentation (>2 spaces at start) → code-ish
    if (/^ {2,}/.test(line)) codeIndicators++;

    // Lines ending with punctuation → prose-ish
    if (/[.!?]$/.test(trimmed)) proseIndicators++;

    // Special characters → code-ish
    if (/[{}();=<>[\]]/.test(trimmed)) codeIndicators++;
    if (/[#$]/.test(trimmed) && !/^# /.test(trimmed)) codeIndicators++;
  }

  // More code indicators than prose indicators
  return codeIndicators >= proseIndicators && codeIndicators >= 2;
}

/**
 * Detect the programming language of a code snippet.
 * Returns the language identifier string (e.g. "typescript"), or null if
 * the text doesn't match any known language above the threshold.
 */
export function detectLanguage(text: string): string | null {
  if (!looksLikeCode(text)) return null;

  const scores: Record<string, number> = {};

  for (const lp of LANG_PATTERNS) {
    let score = 0;
    for (const { regex, weight } of lp.patterns) {
      const matches = text.match(
        new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`),
      );
      if (matches) score += matches.length * weight;
    }
    if (score > 0) scores[lp.lang] = score;
  }

  // "javascript" and "typescript" compete — if both have high scores, prefer TS
  if (scores.javascript && scores.typescript) {
    if (scores.typescript >= scores.javascript) {
      delete scores.javascript;
    } else if (scores.javascript > scores.typescript) {
      delete scores.typescript;
    }
  }

  // Find highest-scoring language
  let bestLang: string | null = null;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestScore >= CODE_THRESHOLD ? bestLang : null;
}

/**
 * Check whether text is already wrapped in markdown code fences.
 */
function isAlreadyFenced(text: string): boolean {
  const trimmed = text.trim();
  return /^```[\s\S]*```\s*$/.test(trimmed);
}

/**
 * Auto-fence pasted code in markdown code blocks.
 * Returns the fenced text and detected language, or null if no action needed.
 */
export function autoFenceCode(text: string): { fenced: string; lang: string } | null {
  if (isAlreadyFenced(text)) return null;
  const lang = detectLanguage(text);
  if (!lang) return null;
  return {
    fenced: `\`\`\`${lang}\n${text}\n\`\`\``,
    lang,
  };
}

/**
 * Attempt to unfence: strip surrounding ``` fences if present.
 * Returns unfenced text if fences were found, null otherwise.
 */
export function unfenceCode(text: string): string | null {
  const trimmed = text.trim();
  const match = /^```\w*\n([\s\S]*)\n```\s*$/.exec(trimmed);
  return match?.[1] ?? null;
}
