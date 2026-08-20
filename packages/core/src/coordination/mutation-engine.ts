/**
 * Deterministic mutation-testing engine ("Kaos Maymunu" / Chaos Monkey).
 *
 * Plans and applies classical boundary-condition mutations to TypeScript
 * source — `>` ↔ `>=`, `+` ↔ `-`, boolean negation, `return x` → `return
 * null`. The engine is deliberately regex/token based, NOT AST based: it has
 * zero dependencies, runs synchronously, and every mutation site is
 * re-derivable from (file, mutation id) alone. Callers (the `mutation_test`
 * director tool) compute the plan, hand it to a chaos-monkey subagent that
 * applies/runs/restores in an isolated worktree, and then compare per-mutant
 * test outcomes against this plan.
 *
 * Safety properties the engine guarantees:
 *  - `applyMutation` is a pure string transform: given the same source and
 *    the same mutation id it always produces the same output.
 *  - Mutations are single-site: exactly one token occurrence changes.
 *  - Ids are stable across runs (position-anchored, not hash-of-content), so
 *    a worktree-chaos agent and the director tool agree on what each id
 *    means without exchanging anything but the id list.
 *
 * @module coordination/mutation-engine
 */

/** Mutation families this engine can plan. */
export type MutationKind =
  | 'relax-boundary' // >  → >=   (or <  → <=)
  | 'tighten-boundary' // >= → >    (or <= → <)
  | 'arith-plus-to-minus' // +  → -
  | 'arith-minus-to-plus' // -  → +
  | 'negate-boolean' // true → false / false → true
  | 'return-null'; // return <expr>; → return null;

export interface MutationPlanItem {
  /** Stable id: `<kind>#<line1based>#<col1based>`. */
  id: string;
  kind: MutationKind;
  /** Project-relative file path, exactly as passed to planMutations. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column of the mutated token start. */
  column: number;
  /** Original source text at the site. */
  original: string;
  /** Replacement text. */
  replacement: string;
}

export interface PlanMutationsOptions {
  /** Hard cap on planned mutants per file. Default 25. */
  maxPerFile?: number | undefined;
}

/** Token patterns per mutation family, anchored to code, not comments/strings. */
interface TokenPattern {
  kind: MutationKind;
  /** Matches the candidate token. */
  regex: RegExp;
  /** Builds the replacement for a matched token. */
  replace: (match: string) => string;
}

const TOKEN_PATTERNS: readonly TokenPattern[] = [
  {
    kind: 'relax-boundary',
    // `>` not followed by `=` and not part of `=>` or `>>`; require code-ish
    // context on both sides so generic text (JSX, strings) is not touched.
    regex: /(?<=[\w\)\]\}'"`])\s*\x20?(?<op>>(?!=|>))/g,
    replace: () => '>=',
  },
  {
    kind: 'tighten-boundary',
    regex: /(?<=[\w\)\]\}'"`])\s*\x20?(?<op>>=)/g,
    replace: () => '>',
  },
  {
    kind: 'arith-plus-to-minus',
    // `+` between operands (binary), not `++`, unary `+x`, or `+=`.
    regex: /(?<=[\w\)\]\}'"`])\s*\x20?(?<op>\+(?!\+|=))/g,
    replace: () => '-',
  },
    {
    kind: 'arith-minus-to-plus',
    // Binary `-` between operands, not `--`, `-=` or negative-number literal.
    regex: /(?<=[\w\)\]\}'"`])\s*\x20?(?<op>-(?!-|=))/g,
    replace: () => '+',
    },
  {
    kind: 'negate-boolean',
    // Standalone boolean literals used as values, not property names.
    regex: /(?<![.\w$])(?<op>true|false)(?![\w$])/g,
    replace: (m) => (m === 'true' ? 'false' : 'true'),
  },
  {
    kind: 'return-null',
    // `return <expr>;` where expr is not already null/undefined/void.
    regex: /(?<indent>\breturn\b)(?<expr>\s+[^;{}\n]+?)\s*;/g,
    replace: () => 'return null;',
  },
];

/**
 * Plan mutations for one file's source text.
 *
 * The scan is line-by-line with the file's own line splits preserved so ids
 * stay (line, column) anchored. Mutations inside comments and string
 * literals are filtered out by `isMasked` below.
 */
export function planMutations(
  file: string,
  source: string,
  opts: PlanMutationsOptions = {},
): MutationPlanItem[] {
  const maxPerFile = opts.maxPerFile ?? 25;
  const out: MutationPlanItem[] = [];

  const lines = source.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const t = line.trim();
    // Skip whole-line comments: `//` lines, JSDoc/block bodies (` * `),
    // openers (`/** … */` single-line JSDoc included) and closers (`*/`).
    // Dogfood finding 2026-08-20: `/** Stable id: <kind>#… */` lines were
    // NOT masked, so the planner emitted dead mutants inside doc comments.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

    for (const pattern of TOKEN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(line)) !== null) {
        const token = m.groups?.['op'] ?? m[0];
        const tokenStart = m.index + m[0].indexOf(token);
        // Only mutate tokens that sit in real code (not comments/strings).
        if (isMasked(line, tokenStart, token.length)) continue;
        const original = line.slice(tokenStart, tokenStart + token.length);
        const replacement = pattern.replace(token);
        if (replacement === original) continue;
        out.push({
          id: `${pattern.kind}#${lineIdx + 1}#${tokenStart + 1}`,
          kind: pattern.kind,
          file,
          line: lineIdx + 1,
          column: tokenStart + 1,
          original,
          replacement,
        });
      }
    }
    if (out.length >= maxPerFile) break;
  }
  return out.slice(0, maxPerFile);
}

/**
 * Apply one planned mutation to source. Pure: same input → same output.
 * Returns the original source when the site no longer matches (the file has
 * drifted since planning) so callers can treat that as a skipped mutant.
 */
export function applyMutation(
  source: string,
  mutation: Pick<MutationPlanItem, 'kind' | 'line' | 'column' | 'original' | 'replacement'>,
): string {
  const lines = source.split('\n');
  const target = lines[mutation.line - 1];
  if (target === undefined) return source;
  const start = mutation.column - 1;
  const tail = target.slice(start);
  if (!tail.startsWith(mutation.original)) return source;
  lines[mutation.line - 1] =
    target.slice(0, start) + mutation.replacement + target.slice(start + mutation.original.length);
  return lines.join('\n');
}

/**
 * True when [start, start+len) on `line` falls inside a line comment,
 * block-comment tail, single- or double-quoted string. The engine only ever
 * plans single-line tokens, so a whole-file comment/string tracker is not
 * needed; this filter exists to keep the obvious false positives out.
 */
function isMasked(line: string, start: number, len: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < start; i++) {
    const c = line[i]!;
    const prev = i > 0 ? line[i - 1] : undefined;
    if (c === "'" && prev !== '\\') inSingle = !inSingle;
    else if (c === '"' && prev !== '\\') inDouble = !inDouble;
    if (!inSingle && !inDouble && c === '/' && prev === '/') return true;
  }
  if (inSingle || inDouble) return true;
  // Token spans a quote boundary (rare; a matched token containing quotes).
  const window = line.slice(start, start + len);
  return /['"]/.test(window);
}

/**
 * Parse a structured mutation report emitted by the chaos-monkey subagent
 * (either via `submit_result` or its final text). Tolerant of surrounding
 * prose: the first JSON object containing a `mutants` array wins.
 */
export function parseMutationReport(
  text: string,
): {
  mutants: Array<{
    id: string;
    file: string;
    line: number;
    kind: string;
    status: 'killed' | 'survived' | 'skipped';
    evidence?: string | undefined;
  }>;
  summary?: string | undefined;
} | undefined {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf('{');
  if (firstBrace >= 0) candidates.push(extractBalancedObject(text, firstBrace));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { mutants?: unknown; summary?: unknown };
      if (!Array.isArray(parsed.mutants)) continue;
      return {
        mutants: parsed.mutants
          .map(normalizeMutantEntry)
          .filter((x): x is NonNullable<typeof x> => Boolean(x)),
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      };
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/**
 * Slice the first balanced `{...}` object starting at `start`, ignoring
 * braces inside JSON string literals. Agents wrap their JSON in prose, and
 * `JSON.parse` rejects trailing text, so the raw suffix alone is not enough.
 */
function extractBalancedObject(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function normalizeMutantEntry(value: unknown):
  | {
      id: string;
      file: string;
      line: number;
      kind: string;
      status: 'killed' | 'survived' | 'skipped';
      evidence?: string | undefined;
    }
  | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;
  const status = rec['status'];
  if (!id || (status !== 'killed' && status !== 'survived' && status !== 'skipped')) {
    return undefined;
  }
  return {
    id,
    file: typeof rec['file'] === 'string' ? rec['file'] : '',
    line: typeof rec['line'] === 'number' ? rec['line'] : 0,
    kind: typeof rec['kind'] === 'string' ? rec['kind'] : '',
    status,
    evidence: typeof rec['evidence'] === 'string' ? rec['evidence'] : undefined,
  };
}
