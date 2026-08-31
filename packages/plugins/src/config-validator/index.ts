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
 *  - `.yaml` / `.yml`        → structural lint: tab indentation
 *    (illegal in YAML), duplicate keys at the same indent within a
 *    block, unclosed quotes
 *  - `.toml`                 → duplicate table headers, duplicate
 *    keys within a table
 *
 * Valid files produce no output — zero noise on the happy path.
 *
 * Config (`config.extensions['config-validator']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".json", ".jsonc", ".yaml", ".yml", ".toml"],
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

const DEFAULT_EXTENSIONS = ['.json', '.jsonc', '.yaml', '.yml', '.toml'];

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
          .map((e) => (e.trim().startsWith('.') ? e.trim().toLowerCase() : `.${e.trim().toLowerCase()}`))
      : [...DEFAULT_EXTENSIONS],
    maxFileBytes:
      typeof rawMax === 'number' && rawMax >= 1024
        ? rawMax
        : DEFAULTS.maxFileBytes,
  };
}

// ---------------------------------------------------------------------------
// Validators — each returns a list of human-readable problems.
// ---------------------------------------------------------------------------

/** Strip // and /* *&#47; comments plus trailing commas for JSONC parsing. */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
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
  return out;
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
  const source = isJsonc ? stripJsonc(text) : text;
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

export function validateYaml(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  // Scope stack: one Set of sibling keys per indentation level.
  // Returning to a shallower indent pops deeper scopes; a list item
  // (`- …`) resets scopes deeper than itself so repeated item shapes
  // (`- name: …` per element) don't count as duplicates.
  const stack: Array<{ level: number; keys: Set<string> }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (/^\s*(#|$)/.test(line)) continue;
    // Tabs in indentation are illegal in YAML.
    const indent = /^([ \t]*)/.exec(line)?.[1] ?? '';
    if (indent.includes('\t')) {
      problems.push(`YAML: tab character in indentation at line ${lineNo} (YAML requires spaces)`);
      continue;
    }
    // Document separator starts a fresh key space.
    if (/^---\s*$/.test(line.trim())) {
      stack.length = 0;
      continue;
    }
    const level = indent.length;
    if (line.trim().startsWith('-')) {
      // New list element: children of the previous element go out of scope.
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level > level) {
        stack.pop();
      }
      continue;
    }
    const keyMatch = /^ *([^\s#][^:]*?):(?:\s|$)/.exec(line);
    if (keyMatch) {
      const key = (keyMatch[1] ?? '').trim();
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level > level) {
        stack.pop();
      }
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        top = { level, keys: new Set<string>() };
        stack.push(top);
      }
      if (top.keys.has(key)) {
        problems.push(`YAML: duplicate key "${key}" at line ${lineNo}`);
      }
      top.keys.add(key);
    }
    // Unclosed quote heuristic: an odd number of unescaped double
    // quotes on one line (YAML strings rarely span lines quoted).
    const doubleQuotes = (line.match(/(?<!\\)"/g) ?? []).length;
    if (doubleQuotes % 2 === 1) {
      problems.push(`YAML: possibly unclosed double quote at line ${lineNo}`);
    }
  }
  return problems;
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
    const keyMatch = /^([A-Za-z0-9_."'-]+)\s*=/.exec(line);
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
  return [];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'config-validator',
  version: '0.1.0',
  description:
    'Validates JSON/JSONC/YAML/TOML files right after write/edit and reports syntax problems in the same turn',
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
      // auto-i18n-extractor, code-metrics, test-coverage-gate.
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
      if (!cfg.extensions.some((ext) => lower.endsWith(ext))) return;

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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook as never, { background: true });

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
