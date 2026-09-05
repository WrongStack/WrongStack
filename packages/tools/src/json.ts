import * as fs from 'node:fs/promises';
import { deepMerge as deepMergeCore } from '@wrongstack/core/utils';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { capSubject, compileUserRegex } from './_regex.js';
import { safeResolveReal } from './_util.js';

/**
 * Files larger than this are rejected before read+parse. `JSON.parse`
 * transiently allocates several times the raw size (string → tokens → object
 * graph) and the parsed result is also returned to the model context, so an
 * unbounded read here is both an OOM vector and a context bomb. Mirrors the
 * size guards every other file-reading tool enforces (read.ts: 5 MiB,
 * grep.ts: 1 MiB, fetch.ts: 128 KiB) — the json tool was the only one
 * without a cap.
 */
const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;
const MAX_JSON_FILE_BYTES_HUMAN = '16 MiB';

/** Thrown when the target file exceeds {@link MAX_JSON_FILE_BYTES}. */
class JsonFileTooLargeError extends Error {
  constructor(filePath: string, size: number) {
    super(
      `json: "${filePath}" is ${size} bytes — exceeds the ${MAX_JSON_FILE_BYTES_HUMAN} file-size limit. ` +
        'Extract the relevant portion into a smaller file first, or use a shell tool to query it directly.',
    );
    this.name = 'JsonFileTooLargeError';
  }
}

/** Thrown when the target file is a directory. */
class JsonFileIsDirectoryError extends Error {
  constructor(filePath: string) {
    super(`json: "${filePath}" is a directory, not a file`);
    this.name = 'JsonFileIsDirectoryError';
  }
}

/** Resolve (containment-checked), size-check, then read a JSON file. */
async function readJsonFileBounded(filePath: string, ctx: Context): Promise<string> {
  const resolved = await safeResolveReal(filePath, ctx);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    throw new JsonFileIsDirectoryError(filePath);
  }
  if (stat.size > MAX_JSON_FILE_BYTES) {
    throw new JsonFileTooLargeError(filePath, stat.size);
  }
  return fs.readFile(resolved, 'utf8');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonAction = 'parse' | 'query' | 'validate' | 'transform' | 'merge';

export interface JsonInput {
  /** Operation to perform. Defaults to 'parse'. */
  action?: JsonAction | undefined;

  // --- parse / query / validate (single data source) ---
  /** Path to JSON/JSON5/YAML file (alternative to `data`). */
  file?: string | undefined;
  /** Inline JSON/JSON5/YAML string (alternative to `file`). */
  data?: string | undefined;
  /** Output format for parse/query/transform results. */
  format?: 'json' | 'json5' | 'yaml' | undefined;

  // --- parse: validate syntax only ---
  validate?: boolean | undefined;

  // --- query / transform ---
  /** JMESPath-like query expression. */
  query?: string | undefined;
  /** Ordered JMESPath transforms (transform action only). */
  transforms?: string[] | undefined;

  // --- validate against schema ---
  /** JSON Schema to validate against. */
  schema?: Record<string, unknown> | undefined;

  // --- merge ---
  /** Base object for merge. */
  base?: unknown | undefined;
  /** Patch object for merge. */
  patch?: unknown | undefined;
  /** Merge conflict resolution: 'prefer-patch' (default) or 'prefer-base'. */
  conflictResolution?: 'prefer-base' | 'prefer-patch' | undefined;
}

export interface JsonOutput {
  data: unknown;
  formatted: string;
  type: string;
  action: string;
  keys?: string[] | undefined;
  query_result?: unknown | undefined;
  result?: unknown | undefined;
  valid?: boolean | undefined;
  errors?: string[] | undefined;
  steps?: Array<{ transform: string; result: unknown }> | undefined;
  error?: string | undefined;
}

export const jsonTool: Tool<JsonInput, JsonOutput> = {
  name: 'json',
  category: 'Data',
  description:
    'Parse, pretty-print, query, validate, transform, and merge JSON/JSON5/YAML. Use `action` to select the operation: parse (default), query, validate, transform, or merge.',
  usageHint:
    'VERY USEFUL FOR DATA INSPECTION:\n\n' +
    '- `action: "parse"` (default): read/pretty-print/convert JSON, JSON5, or YAML from `file` or `data`.\n' +
    '- `action: "query"`: JMESPath-like query (`a.b[0].c`, `items[*].name`, filters, functions).\n' +
    '- `action: "validate"`: validate data against a JSON Schema (`schema` param).\n' +
    '- `action: "transform"`: chain multiple JMESPath transforms (`transforms` param).\n' +
    '- `action: "merge"`: deep merge `base` and `patch` objects (`conflictResolution` param).\n' +
    'Prefer this over raw `read` + manual parsing when dealing with configuration or data files.',
  permission: 'auto',
  mutating: false,
  maxOutputBytes: 262_144,
  timeoutMs: 5_000,
  capabilities: ['fs.read'],
  icon: 'json',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['parse', 'query', 'validate', 'transform', 'merge'],
        description:
          'Operation (default: parse). parse=read/pretty-print, query=JMESPath, validate=schema, transform=chained queries, merge=deep merge.',
      },
      file: { type: 'string', description: 'Path to JSON/JSON5/YAML file (parse/query/validate)' },
      data: {
        type: 'string',
        description: 'JSON/JSON5/YAML string (parse/query/validate, alternative to file)',
      },
      format: {
        type: 'string',
        enum: ['json', 'json5', 'yaml'],
        description: 'Output format for parse/query/transform (default: json)',
      },
      query: {
        type: 'string',
        description: 'JMESPath-like query expression (query action)',
      },
      transforms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered JMESPath query strings (transform action)',
      },
      schema: {
        type: 'object',
        description: 'JSON Schema to validate against (validate action)',
      },
      base: { description: 'Base JSON object (merge action)' },
      patch: { description: 'Patch JSON object to merge in (merge action)' },
      conflictResolution: {
        type: 'string',
        enum: ['prefer-base', 'prefer-patch'],
        description: 'Merge conflict resolution (default: prefer-patch)',
      },
      validate: {
        type: 'boolean',
        description: 'Validate syntax only, no output (parse action, default: false)',
      },
    },
  },
  async execute(input, ctx, opts) {
    const signal = opts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();
    const action = input.action ?? 'parse';

    const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
      'parse',
      'query',
      'validate',
      'transform',
      'merge',
    ]);
    if (input.action !== undefined && !ALLOWED_ACTIONS.has(input.action)) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: String(input.action),
        error: `Unknown action "${input.action}". Allowed actions: parse, query, validate, transform, merge`,
      };
    }

    switch (action) {
      case 'query':
        return executeQuery(input, ctx);
      case 'validate':
        return executeValidate(input, ctx);
      case 'transform':
        return executeTransform(input, ctx);
      case 'merge':
        return executeMerge(input);
      default:
        return executeParse(input, ctx);
    }
  },
};

// ---------------------------------------------------------------------------
// Action: parse (default — the original json tool behavior)
// ---------------------------------------------------------------------------

async function executeParse(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  const format = input.format ?? 'json';

  let parsed: unknown;
  let raw: string;

  if (input.file) {
    try {
      raw = await readJsonFileBounded(input.file, ctx);
    } catch (error) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'parse',
        error:
          error instanceof JsonFileTooLargeError || error instanceof JsonFileIsDirectoryError
            ? error.message
            : 'Could not read file',
      };
    }
  } else if (input.data) {
    raw = input.data;
  } else {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'parse',
      error: 'Provide file or data',
    };
  }

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'parse',
      /* v8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(e) side is defensive. */
      error: `Parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (input.validate) {
    return {
      data: parsed,
      formatted: 'valid',
      type: Array.isArray(parsed) ? 'array' : typeof parsed,
      action: 'parse',
      keys:
        typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as object) : undefined,
    };
  }

  // Backward compat: if `query` is provided without an explicit action,
  // use the original simple path-based query (supports `a.b[0].c` notation).
  if (input.query) {
    const queryResult = simpleQuery(parsed, input.query);
    const formatted = formatOutput(queryResult, format);
    return {
      data: parsed,
      formatted,
      type: Array.isArray(parsed) ? 'array' : typeof parsed,
      action: 'parse',
      keys:
        typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as object) : undefined,
      query_result: queryResult,
    };
  }

  const formatted = formatOutput(parsed, format);

  return {
    data: parsed,
    formatted,
    type: Array.isArray(parsed) ? 'array' : typeof parsed,
    action: 'parse',
    keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as object) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Action: query (JMESPath-like — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeQuery(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  if (!input.query) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'query',
      error: 'query is required for action: query',
    };
  }

  let parsed: unknown;
  if (input.file) {
    try {
      const raw = await readJsonFileBounded(input.file, ctx);
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'query',
        error:
          error instanceof JsonFileTooLargeError || error instanceof JsonFileIsDirectoryError
            ? error.message
            : 'Could not read/parse file',
      };
    }
  } else if (input.data) {
    try {
      parsed = JSON.parse(input.data);
    } catch {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'query',
        error: 'Could not parse data string',
      };
    }
  } else {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'query',
      error: 'Provide file or data',
    };
  }

  try {
    const result = jmespathSearch(parsed, input.query);
    const format = input.format ?? 'json';
    return {
      data: parsed,
      formatted: formatOutput(result, format),
      type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
      action: 'query',
      query_result: result,
    };
  } catch (e) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'query',
      /* v8 ignore next -- defensive String(e) */
      error: `Query failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Action: validate (JSON Schema — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeValidate(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  if (!input.schema) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'validate',
      error: 'schema is required for action: validate',
    };
  }

  let parsed: unknown;
  if (input.file) {
    try {
      const raw = await readJsonFileBounded(input.file, ctx);
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'validate',
        error:
          error instanceof JsonFileTooLargeError || error instanceof JsonFileIsDirectoryError
            ? error.message
            : 'Could not read/parse file',
      };
    }
  } else if (input.data) {
    try {
      parsed = JSON.parse(input.data);
    } catch {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'validate',
        error: 'Could not parse data string',
      };
    }
  } else {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'validate',
      error: 'Provide file or data',
    };
  }

  try {
    const { valid, errors } = validateJsonSchema(parsed, input.schema as Record<string, unknown>);
    return {
      data: parsed,
      formatted: valid ? 'valid' : 'invalid',
      type: Array.isArray(parsed) ? 'array' : typeof parsed,
      action: 'validate',
      valid,
      errors,
    };
  } catch (e) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'validate',
      /* v8 ignore next -- defensive String(e) */
      error: `Validation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Action: transform (chained JMESPath — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeTransform(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  if (!input.transforms || input.transforms.length === 0) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'transform',
      error: 'transforms array is required for action: transform',
    };
  }

  let parsed: unknown;
  if (input.file) {
    try {
      const raw = await readJsonFileBounded(input.file, ctx);
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'transform',
        error:
          error instanceof JsonFileTooLargeError || error instanceof JsonFileIsDirectoryError
            ? error.message
            : 'Could not read/parse file',
      };
    }
  } else if (input.data) {
    try {
      parsed = JSON.parse(input.data);
    } catch {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        action: 'transform',
        error: 'Could not parse data string',
      };
    }
  } else {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'transform',
      error: 'Provide file or data',
    };
  }

  try {
    let current: unknown = parsed;
    const steps: Array<{ transform: string; result: unknown }> = [];

    for (const t of input.transforms) {
      current = jmespathSearch(current, t);
      steps.push({ transform: t, result: current });
    }

    const format = input.format ?? 'json';
    return {
      data: parsed,
      formatted: formatOutput(current, format),
      type: current === null ? 'null' : Array.isArray(current) ? 'array' : typeof current,
      action: 'transform',
      result: current,
      steps,
    };
  } catch (e) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'transform',
      /* v8 ignore next -- defensive String(e) */
      error: `Transform failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Action: merge (deep merge — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeMerge(input: JsonInput): Promise<JsonOutput> {
  if (input.base === undefined || input.patch === undefined) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'merge',
      error: 'base and patch are required for action: merge',
    };
  }

  const conflictResolution = input.conflictResolution ?? 'prefer-patch';

  try {
    const result = deepMergeCore(input.base, input.patch, { conflictResolution });
    const format = input.format ?? 'json';
    return {
      data: result,
      formatted: formatOutput(result, format),
      type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
      action: 'merge',
      result,
    };
  } catch (e) {
    return {
      data: null,
      formatted: '',
      type: 'unknown',
      action: 'merge',
      /* v8 ignore next -- defensive String(e) */
      error: `Merge failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// JMESPath implementation (from json-path plugin)
// ---------------------------------------------------------------------------

function jmespathSearch(data: unknown, query: string): unknown {
  // Handle basic JMESPath expressions
  if (!query || query === '@') return data;

  // Root access
  if (query === '$') return data;

  // Dot notation: foo.bar
  const dotMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(.+))?$/);
  if (dotMatch) {
    const key = dotMatch[1]!;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return undefined;
    }
    const rest = dotMatch[2];
    const val = (data as Record<string, unknown> | undefined)?.[key];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Array access: [0]
  const arrMatch = query.match(/^\[(\d+)\](?:\.(.+))?$/);
  if (arrMatch) {
    const idx = Number.parseInt(arrMatch[1]!, 10);
    const rest = arrMatch[2];
    const arr = data as unknown[];
    const val = arr?.[idx];
    if (rest === undefined) return val;
    return jmespathSearch(val, rest);
  }

  // Wildcard: [*] or [*].rest
  const wildcardMatch = query.match(/^\[\*\](?:\.(.+))?$/);
  if (wildcardMatch) {
    if (!Array.isArray(data)) return [];
    const rest = wildcardMatch[1];
    if (rest === undefined) return data;
    return data.map((item) => jmespathSearch(item, rest));
  }

  // Multi-select: foo.bar[*].baz
  const multiMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[\*\](?:\.(.+))?$/);
  if (multiMatch) {
    const key = multiMatch[1]!;
    const rest = multiMatch[2];
    const arr = (data as Record<string, unknown[]> | undefined)?.[key];
    if (!Array.isArray(arr)) return [];
    if (rest === undefined) return arr;
    return arr.map((item) => jmespathSearch(item, rest));
  }

  // Filter: [?foo==`bar`]
  const filterMatch = query.match(
    /^\[\??([a-zA-Z_][a-zA-Z0-9_]*)(==|!=|<|>|<=|>=)(`[^`]+`|'[^']*')\](?:\.(.+))?$/,
  );
  if (filterMatch) {
    const field = filterMatch[1]!;
    const op = filterMatch[2]!;
    const rawVal = filterMatch[3]!;
    const rest = filterMatch[4];
    let cmpVal: unknown;
    if (rawVal.startsWith("'") && rawVal.endsWith("'")) {
      cmpVal = rawVal.slice(1, -1);
    } else {
      const inner = rawVal.slice(1, -1);
      try {
        cmpVal = JSON.parse(inner);
      } catch {
        cmpVal = inner;
      }
    }
    const arr = data as Record<string, unknown>[];
    if (!Array.isArray(arr)) return [];
    const filtered = arr.filter((item) => {
      const itemVal = (item as Record<string, unknown>)[field];
      switch (op) {
        case '==':
          return itemVal === cmpVal;
        case '!=':
          return itemVal !== cmpVal;
        case '>':
          return Number(itemVal) > Number(cmpVal);
        case '<':
          return Number(itemVal) < Number(cmpVal);
        case '>=':
          return Number(itemVal) >= Number(cmpVal);
        case '<=':
          return Number(itemVal) <= Number(cmpVal);
        /* v8 ignore next -- op is constrained to the six operators by the filter regex; default is unreachable. */
        default:
          return true;
      }
    });
    if (rest === undefined) return filtered;
    return filtered.map((item) => jmespathSearch(item, rest));
  }

  // Function calls: length(@)
  const fnMatch = query.match(/^(length|keys|values|type)\(@\)$/);
  if (fnMatch) {
    const fn = fnMatch[1]!;
    switch (fn) {
      case 'length':
        if (Array.isArray(data)) return data.length;
        if (typeof data === 'string') return data.length;
        if (typeof data === 'object' && data !== null) return Object.keys(data as object).length;
        return 0;
      case 'keys':
        if (typeof data === 'object' && data !== null && !Array.isArray(data))
          return Object.keys(data as object);
        return [];
      case 'values':
        if (typeof data === 'object' && data !== null && !Array.isArray(data))
          return Object.values(data as object);
        return [];
      case 'type':
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        return typeof data;
      /* v8 ignore next 2 -- fn is constrained to the four names by the function regex; default is unreachable. */
      default:
        return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON Schema validator (from json-path plugin)
// ---------------------------------------------------------------------------

function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  function check(value: unknown, s: Record<string, unknown>, path: string): void {
    if (s['type']) {
      const expectedType = s['type'] as string;
      const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      if (expectedType === 'integer') {
        if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${actualType}`);
      } else if (expectedType !== actualType) {
        errors.push(`${path}: expected ${expectedType}, got ${actualType}`);
      }
    }

    if (typeof value === 'string' && s['format'] === 'uri' && value) {
      try {
        new URL(value);
      } catch {
        errors.push(`${path}: not a valid URI`);
      }
    }

    if (typeof value === 'string' && s['pattern']) {
      // The schema is a tool argument — i.e. LLM-controlled and, per this
      // project's own adversary model, untrusted — and the subject is file
      // content. A bare `new RegExp` here would evaluate an attacker-chosen
      // pattern against attacker-chosen input, synchronously, on a regex engine
      // the executor's timeout cannot interrupt. Every other user-regex site in
      // this package already routes through `compileUserRegex` (length cap +
      // catastrophic-backtracking heuristics) and `capSubject`; this one was
      // missed. A malformed pattern also threw here, taking down `validate`
      // instead of reporting an invalid schema.
      const compiled = compileUserRegex(s['pattern'] as string, '');
      if (!compiled.ok) {
        errors.push(`${path}: invalid schema pattern — ${compiled.reason}`);
      } else if (!compiled.regex.test(capSubject(value))) {
        errors.push(`${path}: does not match pattern ${s['pattern']}`);
      }
    }

    if (
      typeof value === 'string' &&
      s['minLength'] !== undefined &&
      value.length < (s['minLength'] as number)
    ) {
      errors.push(`${path}: string too short (min ${s['minLength']})`);
    }

    if (
      typeof value === 'string' &&
      s['maxLength'] !== undefined &&
      value.length > (s['maxLength'] as number)
    ) {
      errors.push(`${path}: string too long (max ${s['maxLength']})`);
    }

    if (
      typeof value === 'number' &&
      s['minimum'] !== undefined &&
      value < (s['minimum'] as number)
    ) {
      errors.push(`${path}: below minimum ${s['minimum']}`);
    }

    if (
      typeof value === 'number' &&
      s['maximum'] !== undefined &&
      value > (s['maximum'] as number)
    ) {
      errors.push(`${path}: above maximum ${s['maximum']}`);
    }

    if (Array.isArray(value) && s['items']) {
      if (Array.isArray(s['items'])) {
        for (let i = 0; i < Math.min(value.length, s['items'].length); i++) {
          check(value[i], s['items'][i] as Record<string, unknown>, `${path}[${i}]`);
        }
      } else if (typeof s['items'] === 'object' && s['items'] !== null) {
        for (let i = 0; i < value.length; i++) {
          check(value[i], s['items'] as Record<string, unknown>, `${path}[${i}]`);
        }
      }
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Array.isArray(s['required'])
    ) {
      const obj = value as Record<string, unknown>;
      for (const req of s['required']) {
        if (typeof req === 'string' && !(req in obj)) {
          errors.push(`${path}: missing required property "${req}"`);
        }
      }
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value) && s['properties']) {
      const props = s['properties'] as Record<string, Record<string, unknown>>;
      for (const [k, propSchema] of Object.entries(props)) {
        check((value as Record<string, unknown>)[k], propSchema, `${path}.${k}`);
      }
    }
  }

  check(data, schema, '$');
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Simple path-based query (original json tool query, backward compat)
// ---------------------------------------------------------------------------

function simpleQuery(data: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
      return undefined;
    }

    const idx = Number(part);
    if (!Number.isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Output formatting (original json tool helpers)
// ---------------------------------------------------------------------------

function formatOutput(data: unknown, format: string): string {
  if (format === 'json5') {
    return JSON.stringify(data, null, 2)
      .replace(/,\s*}/g, '}')
      .replace(/,\s*\]/g, ']');
  }
  if (format === 'yaml') {
    return toYaml(data);
  }
  return JSON.stringify(data, null, 2);
}

function toYaml(data: unknown, indent = 0): string {
  if (data === null) return 'null\n';
  /* v8 ignore next -- parsed JSON never contains `undefined`; defensive for recursive calls. */
  if (data === undefined) return '';
  if (typeof data === 'boolean') return String(data) + '\n';
  if (typeof data === 'number') return String(data) + '\n';
  if (typeof data === 'string') {
    if (data.includes('\n') || data.includes(':') || data.includes('#') || data.startsWith('-')) {
      return `"${data.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
    }
    return data + '\n';
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]\n';
    const prefix = '  '.repeat(indent);
    return data
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const itemEntries = Object.entries(item as Record<string, unknown>);
          if (itemEntries.length === 0) return `${prefix}- {}\n`;
          const [firstK, firstV] = itemEntries[0]!;
          const rest = itemEntries.slice(1);
          let itemYaml = `${prefix}- ${firstK}: ${toYaml(firstV, indent + 2).trimStart()}`;
          for (const [k, v] of rest) {
            itemYaml += `${prefix}  ${k}: ${toYaml(v, indent + 2)}`;
          }
          return itemYaml;
        }
        return `${prefix}- ${toYaml(item, indent + 1).trimStart()}`;
      })
      .join('');
  }
  if (typeof data === 'object') {
    const prefix = '  '.repeat(indent);
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return '{}\n';
    return entries
      .map(([k, v]) => {
        const safeKey = /[:#\s]/.test(k) ? `"${k.replace(/"/g, '\\"')}"` : k;
        if (
          typeof v === 'object' &&
          v !== null &&
          (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)
        ) {
          return `${prefix}${safeKey}:\n${toYaml(v, indent + 1)}`;
        }
        return `${prefix}${safeKey}: ${toYaml(v, indent + 1)}`;
      })
      .join('');
  }
  /* v8 ignore next -- JSON.parse only yields null/bool/number/string/array/object; this fallback is defensive. */
  return String(data) + '\n';
}
