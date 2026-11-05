/**
 * Static safety check for author-supplied regex sources: flags the
 * ambiguous-repetition shapes behind catastrophic backtracking — an
 * unboundedly-quantified group whose body contains another quantifier or an
 * alternation (`(x+x+)+`, `(a|aa)+`, `(\d{2,3})+`), unless the body carries a
 * mandatory literal separator that disambiguates the iterations
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$` is safe: every iteration must start with `-`,
 * which `[a-z0-9]` cannot match, so segmentations are unique).
 *
 * Conservative by design: alternations are always flagged (branch-overlap is
 * not analyzed — `(red|blue)+` fails closed), negated classes and wildcards
 * never prove disjointness, and unknown escapes match anything. The check
 * never executes the regex; the caller reports a distinct error telling the
 * schema author to restructure.
 */
export function patternIsLikelyCatastrophic(source: string): boolean {
  type FrameToken = { kind: 'literal'; ch: string } | { kind: 'quant'; set: CharSet };
  interface Frame {
    hasAlt: boolean;
    hasQuant: boolean;
    tokens: FrameToken[];
  }
  const stack: Frame[] = [];
  let pendingLiteral: string | null = null;
  let pendingSet: CharSet | null = null;

  const flushPending = (): void => {
    const frame = stack[stack.length - 1];
    if (frame !== undefined && pendingLiteral !== null) {
      frame.tokens.push({ kind: 'literal', ch: pendingLiteral });
    }
    pendingLiteral = null;
    pendingSet = null;
  };

  const isDisambiguatedFrame = (frame: Frame): boolean => {
    if (frame.hasAlt) return false;
    if (!frame.hasQuant) return true;
    const quantIndices: number[] = [];
    for (let idx = 0; idx < frame.tokens.length; idx++) {
      if (frame.tokens[idx]?.kind === 'quant') quantIndices.push(idx);
    }
    if (quantIndices.length === 0) return false;
    for (let m = 0; m < quantIndices.length - 1; m++) {
      const qLeft = quantIndices[m]!;
      const qRight = quantIndices[m + 1]!;
      const leftSet = (frame.tokens[qLeft] as { kind: 'quant'; set: CharSet }).set;
      const rightSet = (frame.tokens[qRight] as { kind: 'quant'; set: CharSet }).set;
      let separated = false;
      for (let k = qLeft + 1; k < qRight; k++) {
        const tok = frame.tokens[k];
        if (tok?.kind === 'literal' && leftSet(tok.ch) && rightSet(tok.ch)) {
          separated = true;
          break;
        }
      }
      if (!separated) return false;
    }
    const firstIdx = quantIndices[0]!;
    const lastIdx = quantIndices[quantIndices.length - 1]!;
    const firstSet = (frame.tokens[firstIdx] as { kind: 'quant'; set: CharSet }).set;
    const lastSet = (frame.tokens[lastIdx] as { kind: 'quant'; set: CharSet }).set;
    for (let k = lastIdx + 1; k < frame.tokens.length; k++) {
      const tok = frame.tokens[k];
      if (tok?.kind === 'literal' && lastSet(tok.ch) && firstSet(tok.ch)) return true;
    }
    for (let k = 0; k < firstIdx; k++) {
      const tok = frame.tokens[k];
      if (tok?.kind === 'literal' && lastSet(tok.ch) && firstSet(tok.ch)) return true;
    }
    return false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') {
      // Character-class atom: find the closing bracket (escaped chars stay).
      let j = i + 1;
      if (source[j] === '^') j++;
      const start = j;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j += 2;
        else j++;
      }
      const inner = source.slice(start, j);
      const negated = source[i + 1] === '^';
      flushPending();
      pendingSet = (c) => !classContains(inner, negated, c);
      i = j;
      continue;
    }
    if (ch === '(') {
      flushPending();
      stack.push({ hasAlt: false, hasQuant: false, tokens: [] });
      // Skip group markers so `?` in `(?:`/`(?=` is not read as a quantifier.
      if (source[i + 1] === '?') {
        if (source[i + 2] === ':' || source[i + 2] === '=' || source[i + 2] === '!') i += 2;
        else if (source[i + 2] === '<') {
          // Lookbehind `(?<=`/`(?<!` or a named group `(?<name>`: skip the whole
          // marker, or the name and `>` would be read as literal separators.
          if (source[i + 3] === '=' || source[i + 3] === '!') i += 3;
          else {
            const close = source.indexOf('>', i + 3);
            i = close === -1 ? i + 2 : close;
          }
        }
      }
      continue;
    }
    if (ch === ')') {
      flushPending();
      const frame = stack.pop();
      // A nested group's quantified atoms and alternation also repeat under the
      // enclosing group's quantifier; without this, `((a+)a)+` looked like a
      // body with no quantifier and its trailing `a` "disambiguated" it.
      const parent = stack[stack.length - 1];
      if (frame !== undefined && parent !== undefined) {
        if (frame.hasAlt) parent.hasAlt = true;
        if (frame.hasQuant) parent.hasQuant = true;
        // Its literals stay mandatory unless the group itself is optional.
        const next = source[i + 1];
        const optionalGroup = frame.hasAlt || next === '?' || next === '*' || next === '{';
        for (const tok of frame.tokens) {
          if (tok.kind === 'quant' || !optionalGroup) {
            parent.tokens.push(tok);
          }
        }
      }
      if (frame !== undefined && isUnboundedQuantifier(source, i + 1)) {
        // Disambiguated iterations: every pair of consecutive quantified atoms
        // (including wrap-around across iterations) carries a mandatory literal
        // that neither adjacent quantified atom can match.
        if (!isDisambiguatedFrame(frame)) return true;
      }
      continue;
    }
    if (ch === '|') {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) frame.hasAlt = true;
      flushPending();
      continue;
    }
    if (ch === '+' || ch === '*') {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) {
        frame.tokens.push({ kind: 'quant', set: pendingSet ?? (() => false) });
        frame.hasQuant = true;
      }
      pendingLiteral = null;
      pendingSet = null;
      continue;
    }
    if (ch === '?') {
      // Optional/lazy marker, not an atom: the preceding atom is no longer a
      // mandatory literal, and `?` itself must never become a "separator".
      pendingLiteral = null;
      pendingSet = null;
      continue;
    }
    if (ch === '{') {
      const close = source.indexOf('}', i + 1);
      if (close !== -1 && /^\{\d+(,\d*)?\}$/.test(source.slice(i, close + 1))) {
        const frame = stack[stack.length - 1];
        if (frame !== undefined) {
          frame.tokens.push({ kind: 'quant', set: pendingSet ?? (() => false) });
          frame.hasQuant = true;
        }
        pendingLiteral = null;
        pendingSet = null;
        i = close;
      }
      continue;
    }
    if (ch === '^' || ch === '$') {
      // Zero-width anchors are not atoms; they only end atom adjacency.
      flushPending();
      continue;
    }
    flushPending();
    const atom = charSetAtom(source, i);
    if (atom.literal !== null) pendingLiteral = atom.literal;
    pendingSet = atom.set;
    i += atom.consumed - 1;
  }
  return false;
}

/** True when the atom's set provably does not match `ch` (conservative: false). */
type CharSet = (ch: string) => boolean;

/** Parse the regex atom at `i` into a char-set predicate, a literal (when it
 *  matches exactly one character), and its source width. */
function charSetAtom(
  source: string,
  i: number,
): { set: CharSet; literal: string | null; consumed: number } {
  const c = source[i];
  if (c === undefined) return { set: () => false, literal: null, consumed: 1 };
  if (c === '.') return { set: () => false, literal: null, consumed: 1 };
  if (c === '\\') {
    const e = source[i + 1] ?? '';
    if (e === 'd') return { set: (ch) => !/\d/.test(ch), literal: null, consumed: 2 };
    if (e === 'w') return { set: (ch) => !/\w/.test(ch), literal: null, consumed: 2 };
    if (e === 's') return { set: (ch) => !/\s/.test(ch), literal: null, consumed: 2 };
    if (e === 'D') return { set: (ch) => /\d/.test(ch), literal: null, consumed: 2 };
    if (e === 'W') return { set: (ch) => /\w/.test(ch), literal: null, consumed: 2 };
    if (e === 'S') return { set: (ch) => /\s/.test(ch), literal: null, consumed: 2 };
    // Zero-width assertions consume nothing, so they can never serve as the
    // mandatory literal separator between two quantified atoms.
    if (e === 'b' || e === 'B') return { set: () => false, literal: null, consumed: 2 };
    // Multi-character escapes must consume their WHOLE source width. Reading
    // only `\u`/`\x` left the hex digits to be parsed as literal atoms, which
    // fabricated separators (`\u0061+a?` really is `a+a?`).
    if (e === 'u') {
      if (source[i + 2] === '{') {
        const close = source.indexOf('}', i + 3);
        if (close !== -1) {
          const codePoint = Number.parseInt(source.slice(i + 3, close), 16);
          const consumed = close - i + 1;
          if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
            const decoded = String.fromCodePoint(codePoint);
            return { set: (ch) => ch !== decoded, literal: decoded, consumed };
          }
          return { set: () => false, literal: null, consumed };
        }
      } else {
        const hex = source.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          const decoded = String.fromCharCode(Number.parseInt(hex, 16));
          return { set: (ch) => ch !== decoded, literal: decoded, consumed: 6 };
        }
      }
      return { set: () => false, literal: null, consumed: 2 };
    }
    if (e === 'x') {
      const hex = source.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        const decoded = String.fromCharCode(Number.parseInt(hex, 16));
        return { set: (ch) => ch !== decoded, literal: decoded, consumed: 4 };
      }
      return { set: () => false, literal: null, consumed: 2 };
    }
    if (e === 'c' && /[A-Za-z]/.test(source[i + 2] ?? ''))
      return { set: () => false, literal: null, consumed: 3 };
    if (e === 'p' || e === 'P' || e === 'k') {
      // Unicode property classes and named backreferences: opaque atom, and
      // skip the whole `{...}`/`<...>` payload so its contents are not read as
      // separators either.
      const open = source.indexOf(e === 'k' ? '<' : '{', i + 2);
      const close = open === -1 ? -1 : source.indexOf(e === 'k' ? '>' : '}', open + 1);
      return { set: () => false, literal: null, consumed: close === -1 ? 2 : close - i + 1 };
    }
    if (/[0-9]/.test(e)) {
      // Backreference / octal escape: not a literal separator, and consume
      // every following digit so none of them becomes a fabricated literal.
      let end = i + 2;
      while (/[0-9]/.test(source[end] ?? '')) end++;
      return { set: () => false, literal: null, consumed: end - i };
    }
    return { set: (ch) => ch !== e, literal: e, consumed: 2 };
  }
  return { set: (ch) => ch !== c, literal: c, consumed: 1 };
}

/** Whether the character class with raw `inner` content (negation flagged)
 *  matches `ch`. Unknown escapes match anything (conservative). */
function classContains(inner: string, negated: boolean, ch: string): boolean {
  const found = classWalk(inner, ch);
  return negated ? !found : found;
}

function classWalk(inner: string, ch: string): boolean {
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === undefined) return false;
    if (c === '\\') {
      const e = inner[i + 1] ?? '';
      if (e === 'd' && /\d/.test(ch)) return true;
      if (e === 'w' && /\w/.test(ch)) return true;
      if (e === 's' && /\s/.test(ch)) return true;
      if (e === 'D' && !/\d/.test(ch)) return true;
      if (e === 'W' && !/\w/.test(ch)) return true;
      if (e === 'S' && !/\s/.test(ch)) return true;
      if (e === ch) return true;
      i += 2;
      continue;
    }
    const hi = inner[i + 2];
    if (inner[i + 1] === '-' && hi !== undefined && hi !== ']') {
      if (c <= ch && ch <= hi) return true;
      i += 3;
      continue;
    }
    if (c === ch) return true;
    i++;
  }
  return false;
}

/** True for `+`, `*`, and open-ended `{n,}` — quantifiers with no upper bound. */
function isUnboundedQuantifier(source: string, i: number): boolean {
  if (source[i] === '+' || source[i] === '*') return true;
  if (source[i] === '{') {
    const close = source.indexOf('}', i + 1);
    if (close !== -1) {
      const m = /^\{(\d+)(,(\d+)?)?\}$/.exec(source.slice(i, close + 1));
      // {n} and {n,m} are bounded; {n,} is not.
      return m !== null && m[2] !== undefined && m[3] === undefined;
    }
  }
  return false;
}
