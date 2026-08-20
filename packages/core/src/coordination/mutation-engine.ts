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
  /**
   * When true, BOTH the token's start AND its terminating character must
   * sit in code ranges. For the return-null family the token spans the
   * whole `return <expr>;` match, which may legitimately cross masked
   * template text between the endpoints — but a lazy match whose
   * terminating `;` falls inside a string, template, or regex literal is
   * a partial-token match, and splicing its replacement produces
   * syntactically invalid code whose compile failure would be falsely
   * recorded as a kill.
   */
  endpointsInCode?: boolean;
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
    endpointsInCode: true,
  },
];

/**
 * Plan mutations for one file's source text.
 *
 * The scan is line-by-line with the file's own line splits preserved so ids
 * stay (line, column) anchored. Mutations inside comments, string literals,
 * and template literals (single- or multi-line, interpolation contents
 * excepted) are filtered out by the cross-line scanner `computeLineMasks`
 * below.
 */
export function planMutations(
  file: string,
  source: string,
  opts: PlanMutationsOptions = {},
): MutationPlanItem[] {
  const maxPerFile = opts.maxPerFile ?? 25;
  const out: MutationPlanItem[] = [];

  const lines = source.split('\n');
  // One forward scan classifies every line into mutable code ranges —
  // this is what keeps mutants out of multi-line templates and block
  // comments, which a per-line mask can never see.
  const masks = computeLineMasks(source);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const t = line.trim();
    // Skip whole-line `//` comments. Block comments — single-line JSDoc
    // openers, multi-line bodies, closers — are handled by the cross-line
    // scanner below, which also keeps code that follows a same-line
    // `/* … */` closer mutable. (Dogfood finding 2026-08-20: the old
    // per-line heuristic needed these guard arms; the scanner does not.)
    if (t.startsWith('//')) continue;

    const codeRanges = masks[lineIdx]!;
    // Containment anchors at the token START, not its full span: the
    // return-null family's token is the whole `return <expr>;` match,
    // which legitimately crosses masked template text inside the
    // expression — replacing it with `return null;` is still valid,
    // meaningful code. Operator tokens are 1-2 chars, so start-anchoring
    // loses nothing there; a token beginning inside template text,
    // string, or comment remains masked. For families flagged
    // `endpointsInCode`, the LAST character must also sit in code —
    // see the TokenPattern doc for why return-null needs both ends.
    const inCode = (start: number): boolean => codeRanges.some(([s, e]) => start >= s && start < e);

    for (const pattern of TOKEN_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(line)) !== null) {
        const token = m.groups?.['op'] ?? m[0];
        const tokenStart = m.index + m[0].indexOf(token);
        // Only mutate tokens that begin in real code.
        if (!inCode(tokenStart)) continue;
        // And for endpoint-checked families (return-null), tokens whose
        // terminating character sits in masked content — a lazy match
        // that stopped at a semicolon inside a string/template — are
        // partial-token matches: never plan them.
        if (pattern.endpointsInCode && !inCode(tokenStart + token.length - 1)) continue;
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
 * One forward scan over the whole source, classifying every line into
 * [start, end) ranges of REAL code — everything else (single/double-quoted
 * strings, line comments, block comments, template-literal text) is masked.
 * This is the cross-line replacement for the old per-line `isMasked`:
 * template literals and block comments routinely span lines, so a per-line
 * mask can never see them.
 *
 * Heuristic scanner, deliberately not a parser (same trade-off as the rest
 * of the engine). Regex literals ARE recognized heuristically — a `/`
 * starts a regex when the previous significant token cannot end an operand
 * (identifier vs operand-expecting keyword, `)`/`]`/`.`/quote-close vs
 * operator) — so their braces, brackets and slashes neither corrupt the
 * interpolation depth counter nor mimic comment openers. Genuinely
 * ambiguous contexts (a `/` right after `}`) lean toward "regex" because
 * over-masking is safe for planning; the failure mode this exists to
 * prevent is planning mutants inside string, comment, or template text
 * (or losing whole regions of real code to a corrupted frame stack).
 */
function computeLineMasks(source: string): Array<Array<[number, number]>> {
  const lines = source.split('\n');
    const masks: Array<Array<[number, number]>> = lines.map(() => []);
    // Frame stack for nesting: the bottom frame is plain code; a backtick
    // pushes a template frame; `${` inside a template pushes a code frame
    // (interpolation contents ARE code and stay mutable). `depth` tracks
    // brace nesting inside a code frame so a `}` closes an interpolation
    // only after any inner object literal has closed. `parens` tracks the
    // KIND of each open parenthesis in this frame — control headers
    // (if/for/while/…) vs plain expressions — because a `)` that closes a
    // control header does NOT end an operand: `if (ok) /re/.test(s)` must
    // classify the `/` as a regex, while `f(x) / 2` is division.
    type Frame = {
      kind: 'code' | 'template';
      depth: number;
      parens: Array<'control' | 'expr'>;
    };
    const stack: Frame[] = [{ kind: 'code', depth: 0, parens: [] }];
    let inBlockComment = false;
    // Last significant token consumed in a code frame — persists ACROSS
    // lines, so a line-leading `/` classifies by what the previous line
    // ended with (`total` → continued division; a control-header `)` →
    // if-body regex; an operator → regex).
    let lastToken: string | null = null;
  
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      const ranges = masks[lineIdx]!;
      let runStart: number | null = null;
      const closeRun = (end: number): void => {
        if (runStart !== null && end > runStart) ranges.push([runStart, end]);
        runStart = null;
      };
  
      let i = 0;
      // Resume after a block comment that spanned onto this line.
      if (inBlockComment) {
        const close = line.indexOf('*/');
        if (close === -1) continue; // whole line is comment text
        inBlockComment = false;
        i = close + 2;
      }
  
      while (i < line.length) {
        const top = stack[stack.length - 1]!;
        const c = line[i]!;
        if (top.kind === 'template') {
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === '`') {
            stack.pop();
            lastToken = '`'; // a closed template literal ends an operand
            i++;
            continue;
          }
          if (c === '$' && line[i + 1] === '{') {
            stack.push({ kind: 'code', depth: 0, parens: [] });
            lastToken = '${'; // interpolation opens a fresh expression
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        // Plain code frame.
        if (/[\w$]/.test(c)) {
          // Consume the whole word/number as ONE token so lastToken
          // carries identifiers and keywords (if/return/typeof/…) intact.
          let j = i + 1;
          while (j < line.length && /[\w$]/.test(line[j]!)) j++;
          lastToken = line.slice(i, j);
          if (runStart === null) runStart = i;
          i = j;
          continue;
        }
        if (c === "'" || c === '"') {
          closeRun(i);
          i++;
          while (i < line.length && line[i] !== c) {
            if (line[i] === '\\') i++;
            i++;
          }
          i++; // closing quote (or end of line)
          lastToken = c; // a closed string ends an operand
          continue;
        }
        if (c === '`') {
          closeRun(i);
          stack.push({ kind: 'template', depth: 0, parens: [] });
          i++;
          continue;
        }
        if (c === '/' && line[i + 1] === '/') {
          closeRun(i);
          break; // rest of the line is a comment
        }
        if (c === '/' && line[i + 1] === '*') {
          closeRun(i);
          const close = line.indexOf('*/', i + 2);
          if (close === -1) {
            inBlockComment = true;
            break; // comment continues on following lines
          }
          i = close + 2;
          continue; // a closed block comment is transparent: lastToken unchanged
        }
        // A lone `/` is a regex literal or division. It starts a regex
        // when the previous significant token cannot END an operand —
        // tracked across lines in `lastToken`, and paren-kind aware: a
        // `)` that closed a control header (if/for/while…) does not end
        // an operand, so the statement body may start with a regex
        // literal; a `)` that closed a call or grouping does, making the
        // `/` division. A `/` right after `}` leans regex because
        // over-masking is safe for planning. Skipping the literal
        // wholesale keeps its braces, brackets and slashes away from the
        // interpolation depth counter and the comment detectors.
        if (c === '/') {
          if (!tokenCanEndOperand(lastToken)) {
            closeRun(i);
            const next = skipRegexLiteral(line, i);
            lastToken = next > i + 1 ? 'regex' : '/';
            i = next;
            continue;
          }
        }
        if (c === '(') {
          top.parens.push(CONTROL_KEYWORDS.has(lastToken ?? '') ? 'control' : 'expr');
          lastToken = c;
        } else if (c === ')') {
          const kind = top.parens.pop() ?? 'expr';
          lastToken = kind === 'control' ? 'control-paren-close' : ')';
        } else if (c === '{') {
          top.depth++;
          lastToken = c;
        } else if (c === '}') {
          if (top.depth > 0) {
            top.depth--;
            lastToken = c;
          } else if (stack.length > 1) {
            closeRun(i);
            stack.pop(); // closes a `${…}` interpolation → template text again
            i++;
            continue;
          } else {
            lastToken = c;
          }
        } else if (c !== ' ' && c !== '\t' && c !== '\r') {
          lastToken = c; // operators, commas, semicolons, brackets
        }
        if (runStart === null) runStart = i;
        i++;
      }
      closeRun(line.length);
  }
  return masks;
}

/** Keywords that EXPECT an operand after them — a `/` following one is a regex. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Keywords whose following `(...)` is a CONTROL HEADER (if/for/while/…)
 * rather than a call or grouping. A `)` closing one does not end an
 * operand — the statement body may then start with a regex literal
 * (`if (ok) /re/.test(s)`), unlike `f(x) / 2` which is division.
 * `return` is deliberately absent: `return (x) / 2` is division.
 */
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * Whether `token` can END an operand — if it can, a following `/` is
 * division, not a regex literal. `}` is deliberately NOT here: it is
 * ambiguous (block close vs object-literal close) and leaning "regex"
 * only over-masks, which is safe for planning. `control-paren-close`
 * (a `)` that closed an if/for/while header) also fails this test by
 * design — the statement body may begin with a regex literal.
 */
function tokenCanEndOperand(token: string | null): boolean {
  if (token === null) return false;
  if (/^[\w$]+$/.test(token)) return !KEYWORDS_BEFORE_REGEX.has(token);
  return token === ')' || token === ']' || token === '.' || token === '"' || token === "'" || token === '`';
}

/**
 * Skip a regex literal starting at the opening `/` on `line`: consumes
 * escapes, one character class `[...]`, the closing `/`, and any trailing
 * flag letters. Stops at end of line when unterminated (masks the rest of
 * the line — over-masking is safe for planning).
 */
function skipRegexLiteral(line: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === '/') {
      i++;
      break;
    }
    if (ch === '\n' || ch === '\r') return start + 1; // not a regex — resync
    i++;
  }
  while (i < line.length && /[a-z]/.test(line[i]!)) i++; // flags
  return i;
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
