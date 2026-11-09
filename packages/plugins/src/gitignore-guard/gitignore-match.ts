import { sep } from 'node:path';

// ---------------------------------------------------------------------------
// Matching engine (gitignore-style)
// ---------------------------------------------------------------------------

export function toForwardSlashes(p: string): string {
  // Normalize both the host separator and literal backslashes: project-relative
  // paths handed to the matcher can carry Windows-style separators regardless
  // of the host platform (CI runs Linux; tool callers run Windows).
  return p.split(sep).join('/').replaceAll('\\', '/');
}

// Inner pattern of a gitignore glob (no anchors) over path parts. `*`/`?` stay
// inside one segment; gitignore's double star crosses them: a leading `**/`
// (any leading directories, or none), an inner `/**/` (zero or more
// directories) and a trailing `/**` (everything inside). Reading it as two
// single-segment stars left `**/dist/` or `a/**/b` "uncovered", and the guard
// appended a duplicate line to a .gitignore that already ignored the file.
function globToSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i) && (i === 0 || glob[i - 1] === '/')) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      out += '/.*';
      i += 3;
      continue;
    }
    // A bracket expression (`*.py[cod]`, `[Bb]in/`, `log[!s]/`) is one
    // character from a set — never `/`; a leading `!`/`^` negates it. Like
    // git, a pattern with an unterminated `[` matches nothing.
    if (glob[i] === '[') {
      let j = i + 1;
      const negated = glob[j] === '!' || glob[j] === '^';
      if (negated) j++;
      if (glob[j] === ']') j++; // a leading `]` is a member
      const close = glob.indexOf(']', j);
      if (close === -1) return '(?!)';
      const body = glob.slice(negated ? i + 2 : i + 1, close).replace(/[\\\]^]/g, '\\$&');
      const characterClass = negated ? `[^/${body}]` : `(?!/)[${body}]`;
      try {
        // User-authored ranges such as [z-a] must not crash coverage checks.
        // Treat malformed classes as non-matches, like unterminated brackets.
        new RegExp(characterClass);
      } catch (error) {
        if (error instanceof SyntaxError) return '(?!)';
        throw error;
      }
      out += characterClass;
      i = close + 1;
      continue;
    }
    const ch = glob[i]!;
    if (ch === '*') {
      out += '[^/]*';
      while (glob[i] === '*') i++;
      continue;
    }
    out += ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
    i++;
  }
  return out;
}

/** Convert a single-`*`/`?` glob into an anchored RegExp over path parts. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globToSource(glob)}$`);
}

/**
 * Gitignore-style match of `pattern` against `relPath` (project-relative,
 * forward slashes). See the module doc for the three pattern shapes.
 */
export function matchGitignorePattern(relPath: string, pattern: string): boolean {
  const rel = toForwardSlashes(relPath).replace(/^\//, '');
  let pat = pattern.trim();
  if (pat.length === 0 || pat.startsWith('#')) return false;
  const anchored = pat.startsWith('/');
  if (anchored) {
    pat = pat.slice(1);
    if (pat.length === 0) return false;
  }
  const segments = rel.split('/');
  if (pat.endsWith('/')) {
    const dir = pat.slice(0, -1);
    if (dir.length === 0) return false;
    if (anchored || dir.includes('/')) {
      // Anchored directory pattern (leading or internal slash): the named directory
      // sits at that exact path from the root — matches it and everything
      // beneath it, but not the same directory name elsewhere.
      return new RegExp(`^${globToSource(dir)}(?:/|$)`).test(rel);
    }
    // Bare directory name: matches a directory with that name at any depth.
    // The name is a glob (`*.egg-info/`, `cmake-build-*/`), not a literal.
    const re = globToRegExp(dir);
    return segments.some((s) => re.test(s));
  }
  // A pattern without a trailing `/` matches files AND directories, and git
  // ignores everything beneath an ignored directory. Matching only the full
  // path / basename left `dist/bundle.js` uncovered by a `dist` line, so the
  // hook re-appended `dist/` to a .gitignore that already ignored it.
  if (anchored || pat.includes('/')) {
    return new RegExp(`^${globToSource(toForwardSlashes(pat))}(?:/|$)`).test(rel);
  }
  const re = globToRegExp(pat);
  return segments.some((s) => re.test(s));
}
