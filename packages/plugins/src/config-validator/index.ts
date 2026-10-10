/**
 * config-validator plugin — instant syntax feedback after config-file
 * writes.
 *
 * A broken `package.json` or malformed YAML often goes unnoticed
 * until a later build fails with an unrelated-looking error. This
 * plugin validates config files immediately: a `PostToolUse` hook on
 * `write|edit` re-reads the target file from disk (what actually
 * landed, not what the tool intended) and reports problems via
 * `additionalContext` in the same turn:
 *
 *  - `.json` / `.jsonc`      → strict parse (JSONC comments stripped
 *    first); parse errors include the line/column
 *  - `package.json`          → parse + shape checks (name/version
 *    present, `dependencies` is an object)
 *  - `.yaml` / `.yml`        → parsed (every document of a `---`
 *    stream): syntax errors, duplicate keys, tab indentation, unclosed
 *    quotes — each with its line and column
 *  - `.toml`                 → duplicate table headers, duplicate
 *    keys within a table
 *  - `.env`, `.env.<name>`   → every line is `KEY=value`, a comment or
 *    empty; a multi-line quoted value is closed. Problems name the line,
 *    never its text (dotenv values are secrets)
 *
 * Valid files produce no output — zero noise on the happy path.
 *
 * Config (`config.extensions['config-validator']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".json", ".jsonc", ".yaml", ".yml", ".toml", ".env"],
 *   "maxFileBytes": 1048576
 * }
 * ```
 *
 * Toggle off with `{ "name": "config-validator", "enabled": false }`
 * in `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import { readFileSync, statSync } from 'node:fs';
import type { Plugin } from '@wrongstack/core/types';
import { type ParseError, parse as parseJsonSyntax, printParseErrorCode } from 'jsonc-parser';
import { LineCounter, parseAllDocuments, type YAMLError } from 'yaml';
import { withinProject } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ConfigValidatorState {
  invocations: number;
  filesChecked: number;
  problemsFound: number;
  lastProblem: { path: string; problem: string; when: string } | null;
  hookUnregister: null | (() => void);
}

const state: ConfigValidatorState = {
  invocations: 0,
  filesChecked: 0,
  problemsFound: 0,
  lastProblem: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ConfigValidatorConfig {
  enabled: boolean;
  extensions: string[];
  maxFileBytes: number;
}

/** `.env` stands for every dotenv file (`.env.local` too): see {@link isDotEnvFile}. */
const DEFAULT_EXTENSIONS = ['.json', '.jsonc', '.yaml', '.yml', '.toml', '.env'];

const DEFAULTS: ConfigValidatorConfig = {
  enabled: true,
  extensions: DEFAULT_EXTENSIONS,
  maxFileBytes: 1_048_576,
};

function readConfig(raw: unknown): ConfigValidatorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, extensions: [...DEFAULT_EXTENSIONS] };
  const r = raw as Record<string, unknown>;
  const rawExts = r['extensions'] ?? r['file_extensions'] ?? r['fileExtensions'];
  const rawMax = r['maxFileBytes'] ?? r['max_file_bytes'] ?? r['maxBytes'] ?? r['max_bytes'];
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(rawExts)
      ? rawExts
          .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          .map((e) =>
            e.trim().startsWith('.') ? e.trim().toLowerCase() : `.${e.trim().toLowerCase()}`,
          )
      : [...DEFAULT_EXTENSIONS],
    maxFileBytes: typeof rawMax === 'number' && rawMax >= 1024 ? rawMax : DEFAULTS.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Validators — each returns a list of human-readable problems.
// ---------------------------------------------------------------------------

/** Strip // and /* *&#47; comments plus trailing commas for JSONC parsing. */
function stripJsonc(text: string): { text: string; unclosedBlockLine: number | null } {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let blockAt = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      // Keep the newline. Dropping it made a later syntax error report the
      // line number in the shortened text, not the line in the file.
      if (ch === '\n') out += ch;
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      blockAt = text.slice(0, i).split('\n').length;
      i += 1;
      continue;
    }
    if (ch === ',') {
      // Look ahead for trailing comma before } or ] (skipping whitespace and comments)
      let j = i + 1;
      let isTrailing = false;
      while (j < text.length) {
        const c = text[j]!;
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
          j++;
        } else if (c === '/' && text[j + 1] === '/') {
          j += 2;
          while (j < text.length && text[j] !== '\n') j++;
        } else if (c === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else if (c === '}' || c === ']') {
          isTrailing = true;
          break;
        } else {
          break;
        }
      }
      if (isTrailing) {
        continue;
      }
    }
    out += ch;
  }
  return { text: out, unclosedBlockLine: inBlock ? blockAt : null };
}

function positionToLineCol(text: string, pos: number): { line: number; col: number } {
  const upTo = text.slice(0, pos);
  const line = upTo.split('\n').length;
  const col = pos - upTo.lastIndexOf('\n');
  return { line, col };
}

/**
 * Strip the verbatim file slice V8 embeds in a JSON parse error.
 *
 * `JSON.parse` failures read `Unexpected token 'x', "…40 bytes of the file…"
 * is not valid JSON`. This hook reports into `additionalContext`, so that
 * slice is file content flowing back to the model.
 */
function redactParseSnippet(message: string): string {
  return message.replace(/"[\s\S]{0,200}?"(?= is not valid JSON)/g, '"…"');
}

export function validateJson(text: string, isJsonc: boolean, fileName: string): string[] {
  let source = text;
  if (isJsonc) {
    const stripped = stripJsonc(text);
    if (stripped.unclosedBlockLine !== null) {
      return [`JSONC: block comment opened at line ${stripped.unclosedBlockLine} is never closed`];
    }
    source = stripped.text;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    // package.json shape checks — cheap and catches real mistakes.
    if (/(^|[/\\])package\.json$/i.test(fileName) && parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      const problems: string[] = [];
      if (typeof p['name'] !== 'string' || !p['name']) {
        problems.push('package.json: "name" is missing or not a string');
      }
      if ('version' in p && typeof p['version'] !== 'string') {
        problems.push('package.json: "version" is not a string');
      }
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        if (key in p && (typeof p[key] !== 'object' || p[key] === null || Array.isArray(p[key]))) {
          problems.push(`package.json: "${key}" must be an object`);
        }
      }
      return problems;
    }
    return [];
  } catch (err) {
    const syntaxErrors: ParseError[] = [];
    parseJsonSyntax(source, syntaxErrors, { disallowComments: true, allowTrailingComma: false });
    const firstError = syntaxErrors[0];
    if (firstError) {
      const { line, col } = positionToLineCol(source, firstError.offset);
      return [
        `JSON parse error at line ${line}, column ${col}: ${printParseErrorCode(firstError.error)}`,
      ];
    }
    const message = err instanceof Error ? err.message : String(err);
    // Older V8 format: "... in JSON at position 123"
    const posMatch = /position (\d+)/.exec(message);
    if (posMatch?.[1]) {
      const { line, col } = positionToLineCol(source, Number(posMatch[1]));
      return [`JSON parse error at line ${line}, column ${col}: ${message}`];
    }
    // Node 20+/22 format quotes a context snippet:
    //   Unexpected token ',', ..."1,\n  "b": ,\n}" is not valid JSON
    // Locate the snippet in the source for an approximate line number.
    const snippetMatch = /(?:\.\.\.)?"([\s\S]{4,120})" is not valid JSON/.exec(message);
    if (snippetMatch?.[1]) {
      const idx = source.indexOf(snippetMatch[1]);
      if (idx >= 0) {
        const { line } = positionToLineCol(source, idx);
        // Deliberately NOT the raw V8 message: it embeds a verbatim slice of
        // the file, which this hook then hands back to the model as
        // `additionalContext`. The line number is the useful part.
        return [`JSON parse error near line ${line}`];
      }
    }
    return [`JSON parse error: ${redactParseSnippet(message.split('\n')[0] ?? '')}`];
  }
}

/**
 * YAML is parsed, not linted. The line-based linter this replaced had to
 * re-derive YAML's grammar with regexes and got it wrong in both directions:
 * `run: |` bodies read as keys (this repo's own ci.yml reported
 * `duplicate key "echo "FAIL"`), URL-shaped lockfile keys never matched, and
 * a shell line with one double quote was an "unclosed quote". The hook hands
 * its findings to the model as "fix these before moving on", so every false
 * positive cost a turn and invited an edit to a correct file.
 *
 * `parseAllDocuments` reads every document of a `---` stream. Duplicate keys,
 * tab indentation and unterminated quotes are parse ERRORS there. An
 * application tag (`!Ref`, `!vault`) is valid YAML and only a warning, so it
 * is never reported.
 */
export function validateYaml(text: string): string[] {
  const problems: string[] = [];
  const lineCounter = new LineCounter();
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, { uniqueKeys: true, prettyErrors: false, lineCounter });
  } catch (err) {
    return [`YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    for (const err of doc.errors) {
      const at = lineCounter.linePos(err.pos[0]);
      problems.push(`YAML: ${yamlProblem(err, text)} at line ${at.line}, column ${at.col}`);
    }
  }
  return problems;
}

/**
 * The parser's message, in the words a reader fixes it by. Only the first
 * line: the rest is a source excerpt, which could carry a value.
 */
function yamlProblem(err: YAMLError, text: string): string {
  const first = err.message.split('\n')[0] ?? err.code;
  switch (err.code) {
    case 'DUPLICATE_KEY': {
      // `pos` marks where the key starts; the key runs to its `:`.
      const rest = text.slice(err.pos[0], err.pos[0] + 200);
      const key = (/^('[^'\n]*'|"[^"\n]*"|[^:\n]+?)\s*:/.exec(rest)?.[1] ?? '').trim();
      return key && key.length <= 80
        ? `duplicate key "${key.replace(/^['"]|['"]$/g, '')}"`
        : 'duplicate key';
    }
    case 'TAB_AS_INDENT':
      return 'tab character in indentation (YAML requires spaces)';
    case 'MISSING_CHAR':
      if (first.includes('closing "quote')) return 'unclosed double quote';
      if (first.includes("closing 'quote")) return 'unclosed single quote';
      return first;
    default:
      return first;
  }
}

/** `.env`, `.env.local`, `.env.production`... — dotenv files carry no extension. */
export function isDotEnvFile(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? '';
  return /^\.env(?:\.[\w.-]+)?$/i.test(base);
}

const DOTENV_ASSIGNMENT_RE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=/;

/**
 * Every line of a dotenv file is empty, a comment or `KEY=value`. A quoted
 * value may span lines (`KEY="a` … `b"`), and those lines are not read as
 * assignments. Problems name the line only, never its text: the value of a
 * dotenv line is usually a secret.
 */
export function validateDotEnv(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  let openQuote: '"' | "'" | null = null;
  let openedAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (openQuote) {
      if (closesQuote(line, openQuote)) openQuote = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!DOTENV_ASSIGNMENT_RE.test(trimmed)) {
      problems.push(`.env: line ${i + 1} is not KEY=value, a comment or empty`);
      continue;
    }
    const value = trimmed.slice(trimmed.indexOf('=') + 1).trimStart();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !closesQuote(value.slice(1), quote)) {
      openQuote = quote;
      openedAt = i + 1;
    }
  }
  if (openQuote) problems.push(`.env: the quoted value opened at line ${openedAt} is never closed`);
  return problems;
}

/** True when `text` holds an unescaped `quote` (the closing one). */
function closesQuote(text: string, quote: '"' | "'"): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) return true;
  }
  return false;
}

export function validateToml(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  const tables = new Set<string>();
  const keysInTable = new Map<string, Set<string>>();
  let currentTable = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    const lineNo = i + 1;
    if (line === '' || line.startsWith('#')) continue;
    const tableMatch = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (tableMatch) {
      const isArrayTable = line.startsWith('[[');
      currentTable = (tableMatch[1] ?? '').trim();
      if (isArrayTable) {
        // Each [[table]] instance is a fresh element — keys restart.
        keysInTable.set(currentTable, new Set());
      } else {
        if (tables.has(currentTable)) {
          problems.push(`TOML: duplicate table [${currentTable}] at line ${lineNo}`);
        }
        tables.add(currentTable);
      }
      continue;
    }
    // Three TOML key shapes: a bare key (`A-Za-z0-9_.-`) or a quoted key
    // (double or single), which may contain spaces, dots and colons. The
    // quoted alternatives must match as a unit so `\s*=` is evaluated after the
    // CLOSING quote: with one flat character class, `"my key" = 1` failed to
    // match at all and the line was skipped, so a duplicated quoted key went
    // unreported. The captured form keeps its quotes, as before.
    const keyMatch = /^("(?:[^"]*)"|'(?:[^']*)'|[A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (keyMatch?.[1]) {
      const key = keyMatch[1];
      const seen = keysInTable.get(currentTable) ?? new Set<string>();
      if (seen.has(key)) {
        problems.push(
          `TOML: duplicate key "${key}" in [${currentTable || 'root'}] at line ${lineNo}`,
        );
      }
      seen.add(key);
      keysInTable.set(currentTable, seen);
    }
  }
  return problems;
}

export function validateFile(path: string, text: string): string[] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return validateJson(text, false, path);
  if (lower.endsWith('.jsonc')) return validateJson(text, true, path);
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return validateYaml(text);
  if (lower.endsWith('.toml')) return validateToml(text);
  if (isDotEnvFile(path)) return validateDotEnv(text);
  return [];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'config-validator',
  version: '0.1.0',
  description:
    'Validates JSON/JSONC/YAML/TOML/.env files right after write/edit and reports syntax problems in the same turn',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULT_EXTENSIONS,
        description: 'File extensions to validate (with leading dot).',
      },
      maxFileBytes: {
        type: 'number',
        minimum: 1024,
        default: 1_048_576,
        description: 'Files larger than this are skipped.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.filesChecked = 0;
    state.problemsFound = 0;
    state.lastProblem = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['config-validator']);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { isError?: boolean | undefined } | undefined;
    }) => {
      if (!cfg.enabled) return;
      // Skip if the write/edit itself errored — otherwise a write core REFUSED
      // (outside the project root, blocked by a guard) still reached the read
      // below, turning a rejected tool call into a working read oracle. Every
      // sibling PostToolUse hook in this package checks this: type-gate:343,
      // auto-i18n-extractor, test-coverage-gate.
      if (input.toolResult?.isError) return;
      state.invocations += 1;
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      const raw =
        ti['path'] ??
        ti['file_path'] ??
        ti['filePath'] ??
        ti['TargetFile'] ??
        ti['targetFile'] ??
        ti['file'];
      if (typeof raw !== 'string' || raw.length === 0) return;
      // This was the only plugin in the package that never imported the
      // sandbox helper: `raw` came straight off the tool call and went into
      // statSync/readFileSync, so the model could name any path on the host.
      if (!withinProject(raw)) return;
      const lower = raw.toLowerCase();
      const watched =
        cfg.extensions.some((ext) => lower.endsWith(ext)) ||
        (cfg.extensions.includes('.env') && isDotEnvFile(raw));
      if (!watched) return;

      let text: string;
      try {
        if (statSync(raw).size > cfg.maxFileBytes) return;
        text = readFileSync(raw, 'utf-8');
      } catch {
        return; // File vanished or unreadable — nothing to validate.
      }
      state.filesChecked += 1;
      api.metrics.counter('files_checked');

      const problems = validateFile(raw, text);
      if (problems.length === 0) return;
      state.problemsFound += problems.length;
      state.lastProblem = {
        path: raw,
        problem: problems[0] as string,
        when: new Date().toISOString(),
      };
      api.metrics.counter('problems', problems.length);
      return {
        additionalContext:
          `config-validator: "${raw}" has ${problems.length} problem(s) after this ${input.toolName ?? 'edit'}:\n` +
          problems
            .slice(0, 10)
            .map((p) => `  - ${p}`)
            .join('\n') +
          (problems.length > 10 ? `\n  … and ${problems.length - 10} more` : '') +
          '\nFix these before moving on — downstream tools will fail on this file.',
      };
    };

    // Foreground, deliberately. A background PostToolUse entry's
    // `additionalContext` is never collected (see `scheduleBackground` in
    // `core/hooks/runner.ts`), so in the background this hook read and
    // parsed the written file and then discarded the problem report — the
    // one thing it exists to deliver. The size guard (`maxFileBytes`) and
    // the extension filter keep the foreground cost bounded.
    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook as never);

    // ── config_validator_status tool ──────────────────────────────────
    api.tools.register({
      name: 'config_validator_status',
      description:
        'Reports config-validator state: watched extensions and counters (files checked, problems found).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          extensions: cfg.extensions,
          counters: {
            invocations: state.invocations,
            filesChecked: state.filesChecked,
            problemsFound: state.problemsFound,
          },
          lastProblem: state.lastProblem,
        };
      },
    });

    api.log.info('config-validator plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      extensions: cfg.extensions,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocations,
      filesChecked: state.filesChecked,
      problemsFound: state.problemsFound,
    };
    state.invocations = 0;
    state.filesChecked = 0;
    state.problemsFound = 0;
    state.lastProblem = null;
    api.log.info('config-validator: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `config-validator: ${state.filesChecked} file(s) checked, ${state.problemsFound} problem(s) found`,
      counters: {
        invocations: state.invocations,
        filesChecked: state.filesChecked,
        problemsFound: state.problemsFound,
      },
    };
  },
};

export default plugin;
