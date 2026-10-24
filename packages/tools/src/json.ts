import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { deepMerge as deepMergeCore, toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveReal } from './_util.js';
import { formatOutput } from './json-format.js';
import { jmespathSearch, simpleQuery } from './json-query.js';
import { validateJsonSchema } from './json-schema.js';

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
      `json: "${filePath}" exceeds the ${MAX_JSON_FILE_BYTES_HUMAN} file-size limit (${size} bytes observed). ` +
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
  // A file can grow after stat. Bound the actual read, with one extra byte
  // to distinguish an exact-cap file from an oversized one.
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of createReadStream(resolved, { end: MAX_JSON_FILE_BYTES })) {
    bytesRead += chunk.length;
    if (bytesRead > MAX_JSON_FILE_BYTES) {
      throw new JsonFileTooLargeError(filePath, bytesRead);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytesRead).toString('utf8');
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
}

export const jsonTool: Tool<JsonInput, JsonOutput> = {
  name: 'json',
  category: 'Data',
  description:
    'Parse, pretty-print, query, validate, transform, and merge JSON (read-only — does not write files). Input must be strict JSON; results can be rendered as JSON, JSON5-style, or YAML via `format`. Use `action` to select the operation: parse (default), query, validate, transform, or merge.',
  usageHint:
    'VERY USEFUL FOR DATA INSPECTION:\n\n' +
    '- `action: "parse"` (default): read/pretty-print JSON from `file` or `data` (output as JSON, JSON5-style, or YAML via `format`).\n' +
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
      file: { type: 'string', description: 'Path to a JSON file (parse/query/validate/transform)' },
      data: {
        type: 'string',
        description: 'JSON string (parse/query/validate/transform, alternative to file)',
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
      throw new ToolValidationError({
        message: `json: unknown action "${input.action}". Allowed actions: parse, query, validate, transform, merge`,
        field: 'action',
      });
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

// Every failure below THROWS: the executor only marks a call failed when
// execute() rejects, so returning `{ error }` recorded broken calls as ok.

/** Read the raw source text from `file` or `data`; throws when neither is usable. */
async function readSource(input: JsonInput, ctx: Context, action: JsonAction): Promise<string> {
  if (input.file) {
    try {
      return await readJsonFileBounded(input.file, ctx);
    } catch (error) {
      if (error instanceof JsonFileTooLargeError || error instanceof JsonFileIsDirectoryError) {
        throw error;
      }
      throw new Error(`json: could not read file "${input.file}": ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
  if (input.data) return input.data;
  throw new ToolValidationError({
    message: `json: provide \`file\` or \`data\` for action: ${action}`,
    field: 'file',
  });
}

/** Parse source text as JSON; a syntax error is an input error for `data`, an I/O-side error for `file`. */
function parseSource(raw: string, input: JsonInput): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = `json: parse failed${input.file ? ` for "${input.file}"` : ''}: ${toErrorMessage(error)}`;
    if (input.file) throw new Error(message, { cause: error });
    throw new ToolValidationError({ message, field: 'data', cause: error });
  }
}

async function executeParse(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  const format = input.format ?? 'json';

  const raw = await readSource(input, ctx, 'parse');

  if (input.validate) {
    // Syntax-check mode: "is this valid JSON?" is the question being asked, so
    // a syntax error is the answer (valid: false), not a tool failure.
    let checked: unknown;
    try {
      checked = JSON.parse(raw);
    } catch (error) {
      return {
        data: null,
        formatted: 'invalid',
        type: 'unknown',
        action: 'parse',
        valid: false,
        errors: [`Parse failed: ${toErrorMessage(error)}`],
      };
    }
    return {
      data: checked,
      formatted: 'valid',
      type: Array.isArray(checked) ? 'array' : typeof checked,
      action: 'parse',
      valid: true,
      keys:
        typeof checked === 'object' && checked !== null
          ? Object.keys(checked as object)
          : undefined,
    };
  }

  const parsed = parseSource(raw, input);

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
    throw new ToolValidationError({
      message: 'json: query is required for action: query',
      field: 'query',
    });
  }

  const parsed = parseSource(await readSource(input, ctx, 'query'), input);

  let result: unknown;
  try {
    result = jmespathSearch(parsed, input.query);
  } catch (error) {
    throw new Error(`json: query failed: ${toErrorMessage(error)}`, { cause: error });
  }
  const format = input.format ?? 'json';
  return {
    data: parsed,
    formatted: formatOutput(result, format),
    type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    action: 'query',
    query_result: result,
  };
}

// ---------------------------------------------------------------------------
// Action: validate (JSON Schema — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeValidate(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  if (!input.schema) {
    throw new ToolValidationError({
      message: 'json: schema is required for action: validate',
      field: 'schema',
    });
  }

  const parsed = parseSource(await readSource(input, ctx, 'validate'), input);

  // `valid: false` is the answer to a successful check and stays a return
  // value; only a validator crash is a tool failure.
  let outcome: { valid: boolean; errors: string[] };
  try {
    outcome = validateJsonSchema(parsed, input.schema as Record<string, unknown>);
  } catch (error) {
    throw new Error(`json: schema validation failed to run: ${toErrorMessage(error)}`, {
      cause: error,
    });
  }
  return {
    data: parsed,
    formatted: outcome.valid ? 'valid' : 'invalid',
    type: Array.isArray(parsed) ? 'array' : typeof parsed,
    action: 'validate',
    valid: outcome.valid,
    errors: outcome.errors,
  };
}

// ---------------------------------------------------------------------------
// Action: transform (chained JMESPath — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeTransform(input: JsonInput, ctx: Context): Promise<JsonOutput> {
  if (!input.transforms || input.transforms.length === 0) {
    throw new ToolValidationError({
      message: 'json: transforms array is required for action: transform',
      field: 'transforms',
    });
  }

  const parsed = parseSource(await readSource(input, ctx, 'transform'), input);

  let current: unknown = parsed;
  const steps: Array<{ transform: string; result: unknown }> = [];
  for (const t of input.transforms) {
    try {
      current = jmespathSearch(current, t);
    } catch (error) {
      throw new Error(`json: transform "${t}" failed: ${toErrorMessage(error)}`, { cause: error });
    }
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
}

// ---------------------------------------------------------------------------
// Action: merge (deep merge — from json-path plugin)
// ---------------------------------------------------------------------------

async function executeMerge(input: JsonInput): Promise<JsonOutput> {
  if (input.base === undefined || input.patch === undefined) {
    throw new ToolValidationError({
      message: 'json: base and patch are required for action: merge',
      field: input.base === undefined ? 'base' : 'patch',
    });
  }

  const conflictResolution = input.conflictResolution ?? 'prefer-patch';

  let result: unknown;
  try {
    result = deepMergeCore(input.base, input.patch, { conflictResolution });
  } catch (error) {
    throw new Error(`json: merge failed: ${toErrorMessage(error)}`, { cause: error });
  }
  const format = input.format ?? 'json';
  return {
    data: result,
    formatted: formatOutput(result, format),
    type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
    action: 'merge',
    result,
  };
}
