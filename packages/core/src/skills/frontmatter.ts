/**
 * Shared SKILL.md frontmatter parser + agentskills.io name validation.
 *
 * The SKILL.md format (https://agentskills.io/specification) is YAML
 * frontmatter between `---` markers followed by a Markdown body. This parser is
 * intentionally minimal — it handles the fields skills actually use, with YAML
 * block scalars (`|` / `>`) for multi-line values and an indented map for
 * `metadata`. It is NOT a general YAML parser; skill files are trusted markdown.
 */
export interface ParsedSkillFrontmatter {
  name?: string | undefined;
  description?: string | undefined;
  /**
   * Optional explicit "Use when…" trigger (WrongStack extension). When present
   * it is used verbatim as the skill's trigger in the available-skills list;
   * otherwise the trigger falls back to the first sentence of `description`.
   */
  trigger?: string | undefined;
  /** WrongStack extension; informational only. */
  version?: string | undefined;
  license?: string | undefined;
  compatibility?: string | undefined;
  metadata?: Record<string, string> | undefined;
  /**
   * `allowed-tools` (agentskills.io spec, experimental) → split on whitespace.
   * INFORMATIONAL ONLY: WrongStack parses and can surface this list but does NOT
   * enforce it — the `skill` tool's permissions/capabilities are fixed and never
   * consult this field, so it neither grants nor restricts any tool.
   */
  allowedTools?: string[] | undefined;
  /** WrongStack stable runtime capabilities required before this skill may load. */
  requiredCapabilities?: string[] | undefined;
  /** Exact registered tool names required before this skill may render or load. */
  requiredTools?: string[] | undefined;
  /** Capabilities that improve the workflow but have documented fallbacks. */
  optionalCapabilities?: string[] | undefined;
}

/** Fields whose value is a single scalar string. */
const SCALAR_KEYS = new Set([
  'name',
  'description',
  'trigger',
  'version',
  'license',
  'compatibility',
]);

/**
 * Parse the YAML frontmatter block from a raw SKILL.md file. Returns `{}` when
 * there is no (or unclosed) frontmatter — callers treat that as "skip".
 *
 * Line endings are normalized first: CRLF (and lone CR) would otherwise leave a
 * trailing `\r` on each line, and since `.` / `$` don't match `\r`, the
 * `key: value` regex would fail on every line and silently drop the whole
 * frontmatter. Real skill files are frequently CRLF (Windows / some editors).
 */
export function parseSkillFrontmatter(raw: string): ParsedSkillFrontmatter {
  const text = normalizeLineEndings(raw);
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  return parseFrontmatterBlock(text.slice(4, end));
}

/** Strip leading YAML frontmatter (`---\n…\n---`) from a SKILL.md file. */
export function stripFrontmatter(raw: string): string {
  const text = normalizeLineEndings(raw);
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return text;
  let body = text.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

/** Normalize CRLF and lone CR to LF. */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function parseFrontmatterBlock(block: string): ParsedSkillFrontmatter {
  const out: ParsedSkillFrontmatter = {};
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] ?? '';
    const rest = (m[2] ?? '').trim();

    if (key === 'metadata') {
      const map: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const sub = lines[i] ?? '';
        const sm = /^\s+([a-zA-Z0-9_.-]+):\s*(.*)$/.exec(sub);
        if (!sm) break;
        map[sm[1] ?? ''] = unquote((sm[2] ?? '').trim());
        i++;
      }
      if (Object.keys(map).length > 0) out.metadata = map;
      continue;
    }

    if (rest === '|' || rest === '>') {
      // Block scalar — collect following indented (or blank) lines.
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const sub = lines[i] ?? '';
        if (sub === '' || sub.startsWith(' ') || sub.startsWith('\t')) {
          collected.push(sub.replace(/^\s+/, ''));
          i++;
        } else break;
      }
      (out as Record<string, unknown>)[normalizeKey(key)] = collected.join('\n').trim();
      continue;
    }

    if (
      key === 'allowed-tools' ||
      key === 'allowedTools' ||
      key === 'required-capabilities' ||
      key === 'requiredCapabilities' ||
      key === 'required-tools' ||
      key === 'requiredTools' ||
      key === 'optional-capabilities' ||
      key === 'optionalCapabilities'
    ) {
      if (rest !== '') {
        const values = rest
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(/[\s,]+/)
          .map(unquote)
          .filter(Boolean);
        (out as Record<string, unknown>)[normalizeKey(key)] = values;
        i++;
      } else {
        const values: string[] = [];
        i++;
        while (i < lines.length) {
          const sub = lines[i] ?? '';
          const bm = /^\s*-\s+(.*)$/.exec(sub);
          if (bm) {
            const val = unquote((bm[1] ?? '').trim());
            if (val) values.push(val);
            i++;
          } else {
            break;
          }
        }
        (out as Record<string, unknown>)[normalizeKey(key)] = values;
      }
      continue;
    }

    if (SCALAR_KEYS.has(key)) {
      (out as Record<string, unknown>)[key] = unquote(rest);
      i++;
      continue;
    }

    // Unknown key — ignore.
    i++;
  }
  return out;
}

/** `allowed-tools` (hyphen) → `allowedTools` (camel); other keys pass through. */
function normalizeKey(key: string): string {
  if (key === 'allowed-tools') return 'allowedTools';
  if (key === 'required-capabilities') return 'requiredCapabilities';
  if (key === 'required-tools') return 'requiredTools';
  if (key === 'optional-capabilities') return 'optionalCapabilities';
  return key;
}

/** Strip surrounding single/double YAML quotes from a scalar value. */
function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** True when `name` matches the agentskills.io name format (chars + length only). */
export function isValidSkillNameFormat(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * Validate a skill `name` against the agentskills.io spec:
 * 1-64 chars; lowercase letters, digits, and single hyphens only; no
 * leading/trailing/consecutive hyphens. Pass the parent directory name to also
 * enforce the "name must match the parent directory" rule.
 *
 * Returns a list of human-readable violations (empty = valid).
 */
export function validateSkillName(name: string, parentDirName?: string): string[] {
  const errors: string[] = [];
  if (!name || name.trim().length === 0) {
    errors.push('name is empty');
    return errors;
  }
  if (name.length > 64) errors.push(`name is ${name.length} characters (max 64)`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    errors.push(
      'name must be lowercase letters, digits, and single hyphens only ' +
        '(no leading/trailing/consecutive hyphens)',
    );
  }
  if (parentDirName !== undefined && name !== parentDirName) {
    errors.push(`name "${name}" must match its parent directory "${parentDirName}"`);
  }
  return errors;
}
