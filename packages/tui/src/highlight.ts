// Lightweight, synchronous syntax highlighter that emits Ink <Text color>
// SEGMENTS — never raw ANSI escape codes. This matters: Ink measures text by
// the visible glyphs of the strings it is given, and embedded SGR escapes
// inflate that measurement and corrupt the viewport's clip/scroll math. By
// returning {text,color} tokens (the caller wraps each in <Text color>), Ink
// owns the styling and width stays exact.
//
// It is deliberately a shallow regex/scan tokenizer, not a real parser —
// approximate coloring reads fine in a terminal. The ONE invariant every
// language path must keep: the concatenation of token texts equals the input
// line (no glyph added or dropped), so measurement never drifts. A test
// asserts `tokens.map(t=>t.text).join('') === line` across a corpus.

export interface Token {
  text: string;
  color?: string | undefined;
  dim?: boolean | undefined;
  bold?: boolean | undefined;
}

export type Lang = 'ts' | 'js' | 'json' | 'bash' | 'python' | 'diff' | 'plain';

/** Carry state for constructs that span lines (block comments, triple strings). */
export interface HLState {
  block?: boolean | undefined; // inside a /* … */ comment (ts/js)
  triple?: string | null; // inside a python triple-quoted string ("""/''')
}

// Syntax colors are emitted as SEMANTIC ROLE NAMES, not literal Ink colors.
//
// This module stays a pure, theme-free tokenizer: it never imports `theme`
// and never decides a hex. The `syntax.*` names are resolved at render time
// by `softColor` (theme.ts) against the ACTIVE palette, via the Ink shim that
// every component already funnels its color props through.
//
// Emitting bare names here (`'magenta'`, `'green'`) was the reason syntax
// highlighting ignored `/theme`: those resolve against the FROZEN `pastel`
// map, so a Gruvbox diff rendered Catppuccin-purple keywords.
//
// Every name below MUST exist in `SYNTAX_TOKEN`. An unresolvable name reaches
// chalk, which drops it silently — the token renders with no color at all.
const C = {
  keyword: 'syntax.keyword',
  string: 'syntax.string',
  comment: 'syntax.comment',
  number: 'syntax.number',
  literal: 'syntax.literal', // true/false/null
  property: 'syntax.property',
  variable: 'syntax.variable',
  command: 'syntax.command',
  flag: 'syntax.flag',
  decorator: 'syntax.decorator',
  diffAdd: 'syntax.diffAdd',
  diffDel: 'syntax.diffDel',
  diffMeta: 'syntax.diffMeta',
} as const;

const TS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'import',
  'export',
  'from',
  'as',
  'default',
  'async',
  'await',
  'yield',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'in',
  'of',
  'this',
  'super',
  'void',
  'delete',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'get',
  'set',
  'true',
  'false',
  'null',
  'undefined',
  'never',
  'any',
  'unknown',
  'string',
  'number',
  'boolean',
  'satisfies',
]);

const PY_KEYWORDS = new Set([
  'def',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'break',
  'continue',
  'class',
  'import',
  'from',
  'as',
  'with',
  'try',
  'except',
  'finally',
  'raise',
  'yield',
  'lambda',
  'pass',
  'global',
  'nonlocal',
  'assert',
  'del',
  'and',
  'or',
  'not',
  'in',
  'is',
  'None',
  'True',
  'False',
  'async',
  'await',
  'self',
  'print',
]);

const BASH_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'in',
  'select',
  'return',
  'export',
  'local',
  'readonly',
  'source',
  'echo',
  'cd',
  'set',
  'unset',
]);

// Anchored (^) so `.match` only matches at the START of the sliced remainder.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const WS = /^\s+/;
const BASH_VAR = /^(?:\$\{[^}]*\}|\$[A-Za-z0-9_]+)/;
const BASH_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*/;
const BASH_WORD = /^[A-Za-z0-9_./-]+/;
const PY_DECORATOR = /^@[A-Za-z_][A-Za-z0-9_.]*/;

/** Return the match of anchored `re` at position `i`, or null. */
function matchAt(re: RegExp, s: string, i: number): string | null {
  const m = s.slice(i).match(re);
  return m ? m[0] : null;
}

/** Consume a quoted string starting at i (quote char = s[i]); returns the span
 *  including both quotes (or to end of line if unterminated). Length-preserving. */
function readString(s: string, i: number): string {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (s[j] === q) {
      j += 1;
      break;
    }
    j += 1;
  }
  return s.slice(i, Math.min(j, s.length));
}

function tokenizeCLike(
  line: string,
  kw: Set<string>,
  carry: HLState,
): { tokens: Token[]; carry: HLState } {
  const tokens: Token[] = [];
  let i = 0;
  const next: HLState = { ...carry };

  // Continue an open block comment from a previous line.
  if (next.block) {
    const end = line.indexOf('*/');
    if (end === -1) {
      tokens.push({ text: line, color: C.comment, dim: true });
      return { tokens, carry: { block: true } };
    }
    tokens.push({ text: line.slice(0, end + 2), color: C.comment, dim: true });
    i = end + 2;
    next.block = false;
  }

  while (i < line.length) {
    const ch = line[i] ?? '';
    const two = line.slice(i, i + 2);

    if (two === '//') {
      tokens.push({ text: line.slice(i), color: C.comment, dim: true });
      break;
    }
    if (two === '/*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        tokens.push({ text: line.slice(i), color: C.comment, dim: true });
        next.block = true;
        break;
      }
      tokens.push({ text: line.slice(i, end + 2), color: C.comment, dim: true });
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const str = readString(line, i);
      tokens.push({ text: str, color: C.string });
      i += str.length;
      continue;
    }
    const ws = matchAt(WS, line, i);
    if (ws) {
      tokens.push({ text: ws });
      i += ws.length;
      continue;
    }
    const num = matchAt(NUMBER, line, i);
    if (num) {
      tokens.push({ text: num, color: C.number });
      i += num.length;
      continue;
    }
    const id = matchAt(IDENT, line, i);
    if (id) {
      tokens.push(kw.has(id) ? { text: id, color: C.keyword } : { text: id });
      i += id.length;
      continue;
    }
    // Punctuation / anything else — one char, uncolored. Always advances.
    tokens.push({ text: ch });
    i += 1;
  }
  return { tokens, carry: next };
}

function tokenizeJson(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === '"') {
      const str = readString(line, i);
      // Property key if the next non-space char is a colon.
      let k = i + str.length;
      while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k += 1;
      tokens.push({ text: str, color: line[k] === ':' ? C.property : C.string });
      i += str.length;
      continue;
    }
    const ws = matchAt(WS, line, i);
    if (ws) {
      tokens.push({ text: ws });
      i += ws.length;
      continue;
    }
    const num = matchAt(NUMBER, line, i);
    if (num) {
      tokens.push({ text: num, color: C.number });
      i += num.length;
      continue;
    }
    const id = matchAt(IDENT, line, i);
    if (id) {
      tokens.push(
        id === 'true' || id === 'false' || id === 'null'
          ? { text: id, color: C.literal }
          : { text: id },
      );
      i += id.length;
      continue;
    }
    tokens.push({ text: ch });
    i += 1;
  }
  return tokens;
}

function tokenizeBash(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let firstWord = true;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === '#') {
      tokens.push({ text: line.slice(i), color: C.comment, dim: true });
      break;
    }
    if (ch === '"' || ch === "'") {
      const str = readString(line, i);
      tokens.push({ text: str, color: C.string });
      i += str.length;
      continue;
    }
    if (ch === '$') {
      const varMatch = matchAt(BASH_VAR, line, i);
      if (varMatch) {
        tokens.push({ text: varMatch, color: C.variable });
        i += varMatch.length;
        continue;
      }
    }
    const ws = matchAt(WS, line, i);
    if (ws) {
      tokens.push({ text: ws });
      i += ws.length;
      continue;
    }
    if (ch === '-' && firstWord === false) {
      const flag = matchAt(BASH_FLAG, line, i);
      if (flag) {
        tokens.push({ text: flag, color: C.flag });
        i += flag.length;
        continue;
      }
    }
    const id = matchAt(BASH_WORD, line, i);
    if (id) {
      const color = firstWord ? C.command : BASH_KEYWORDS.has(id) ? C.keyword : undefined;
      tokens.push(color ? { text: id, color } : { text: id });
      i += id.length;
      firstWord = false;
      continue;
    }
    tokens.push({ text: ch });
    i += 1;
    if (ch !== ' ' && ch !== '\t') firstWord = false;
  }
  return tokens;
}

function tokenizePython(line: string, carry: HLState): { tokens: Token[]; carry: HLState } {
  const tokens: Token[] = [];
  const next: HLState = { ...carry };
  let i = 0;

  if (next.triple) {
    const close = line.indexOf(next.triple);
    if (close === -1) {
      tokens.push({ text: line, color: C.string });
      return { tokens, carry: next };
    }
    tokens.push({ text: line.slice(0, close + 3), color: C.string });
    i = close + 3;
    next.triple = null;
  }

  while (i < line.length) {
    const ch = line[i] ?? '';
    const three = line.slice(i, i + 3);
    if (ch === '#') {
      tokens.push({ text: line.slice(i), color: C.comment, dim: true });
      break;
    }
    if (three === '"""' || three === "'''") {
      const close = line.indexOf(three, i + 3);
      if (close === -1) {
        tokens.push({ text: line.slice(i), color: C.string });
        next.triple = three;
        break;
      }
      tokens.push({ text: line.slice(i, close + 3), color: C.string });
      i = close + 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const str = readString(line, i);
      tokens.push({ text: str, color: C.string });
      i += str.length;
      continue;
    }
    if (ch === '@') {
      const dec = matchAt(PY_DECORATOR, line, i);
      if (dec) {
        tokens.push({ text: dec, color: C.decorator });
        i += dec.length;
        continue;
      }
    }
    const ws = matchAt(WS, line, i);
    if (ws) {
      tokens.push({ text: ws });
      i += ws.length;
      continue;
    }
    const num = matchAt(NUMBER, line, i);
    if (num) {
      tokens.push({ text: num, color: C.number });
      i += num.length;
      continue;
    }
    const id = matchAt(IDENT, line, i);
    if (id) {
      tokens.push(PY_KEYWORDS.has(id) ? { text: id, color: C.keyword } : { text: id });
      i += id.length;
      continue;
    }
    tokens.push({ text: ch });
    i += 1;
  }
  return { tokens, carry: next };
}

function tokenizeDiff(line: string): Token[] {
  // Whole-line classification — one token, length-preserving.
  if (line.startsWith('@@')) return [{ text: line, color: C.diffMeta }];
  if (line.startsWith('+++') || line.startsWith('---'))
    return [{ text: line, color: C.diffMeta, dim: true }];
  if (line.startsWith('+')) return [{ text: line, color: C.diffAdd }];
  if (line.startsWith('-')) return [{ text: line, color: C.diffDel }];
  return [{ text: line, dim: true }];
}

/**
 * Highlight ONE line. `carry` threads multi-line state (block comments, triple
 * strings) from the previous line; pass the returned `carry` into the next call.
 * Guarantees `result.tokens.map(t=>t.text).join('') === line`.
 */
export function highlightLine(
  line: string,
  lang: Lang,
  carry: HLState = {},
): { tokens: Token[]; carry: HLState } {
  switch (lang) {
    case 'ts':
    case 'js':
      return tokenizeCLike(line, TS_KEYWORDS, carry);
    case 'json':
      return { tokens: tokenizeJson(line), carry: {} };
    case 'bash':
      return { tokens: tokenizeBash(line), carry: {} };
    case 'python':
      return tokenizePython(line, carry);
    case 'diff':
      return { tokens: tokenizeDiff(line), carry: {} };
    default:
      return { tokens: line.length > 0 ? [{ text: line }] : [], carry: {} };
  }
}

const LANG_ALIASES: Record<string, Lang> = {
  ts: 'ts',
  tsx: 'ts',
  typescript: 'ts',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  json5: 'json',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  python: 'python',
  diff: 'diff',
  patch: 'diff',
};

/** Map a code-fence info string (```ts, ```bash, …) to a supported Lang. */
export function detectLang(fenceInfo: string): Lang {
  const tag = fenceInfo.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return LANG_ALIASES[tag] ?? 'plain';
}

/**
 * Infer a supported Lang from a file path's extension (`foo/bar.tsx` → `ts`).
 * Used by diff rendering to syntax-highlight changed/context lines of the
 * touched file. Unknown or missing extensions fall back to `plain`.
 */
export function langFromPath(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  const ext = m?.[1]?.toLowerCase() ?? '';
  return LANG_ALIASES[ext] ?? 'plain';
}
