/**
 * Input parsing for `wstack tools run | batch`: where a call's JSON comes from
 * (`--input`), schema-driven `-- --field value` shortcuts, and JSONL batches.
 *
 * Every failure here is a {@link ToolsCliUsageError} — the caller's input is
 * wrong, so the tool never runs and the exit code is 2.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JSONSchema } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';

export class ToolsCliUsageError extends Error {}

/** Where `wstack tools` writes and reads — injectable for tests. */
export interface ToolsCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
}

/** Upper bound for `--input` from stdin or `@file` — tool calls, not a payload upload. */
export const TOOLS_CLI_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Upper bound for one `wstack tools batch` run. */
const TOOLS_CLI_MAX_BATCH_CALLS = 500;

/**
 * Raw text behind `--input`: absent → undefined; a bare `--input` or
 * `--input=-` → stdin (`--input -` parses as bare: the top-level parser never
 * takes a dash-led token as a value); `@path` → file relative to cwd; anything
 * else → the value itself. A leading BOM (editors, `Out-File`) is dropped.
 */
export async function readInputText(
  raw: string | boolean | undefined,
  cwd: string,
  readStdin: () => Promise<string>,
): Promise<{ text: string; source: string } | undefined> {
  if (raw === undefined || raw === false) return undefined;
  let text: string;
  let source: string;
  if (raw === true || raw === '-') {
    text = await readStdin();
    source = 'stdin';
  } else if (raw.startsWith('@')) {
    const file = path.resolve(cwd, raw.slice(1));
    const stat = await fs.stat(file).catch((err: unknown) => {
      throw new ToolsCliUsageError(`--input ${raw}: ${toErrorMessage(err)}`);
    });
    if (!stat.isFile()) throw new ToolsCliUsageError(`--input ${raw}: not a regular file`);
    if (stat.size > TOOLS_CLI_MAX_INPUT_BYTES) {
      throw new ToolsCliUsageError(
        `--input ${raw}: larger than ${TOOLS_CLI_MAX_INPUT_BYTES} bytes`,
      );
    }
    text = await fs.readFile(file, 'utf8');
    source = raw;
  } else {
    text = raw;
    source = '--input';
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, source };
}

/** A tool input must be a JSON object; blank text is `{}`. */
export function parseInputObject(text: string, source: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ToolsCliUsageError(`${source} is not valid JSON: ${toErrorMessage(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ToolsCliUsageError(
      `${source} must be a JSON object (the tool's input), not ${kindOf(parsed)}`,
    );
  }
  return parsed;
}

/**
 * `wstack tools run grep -- --pattern foo --path src --context 2`: map the
 * tokens after `--` onto the tool's input schema.
 *
 * Only after `--`: before it, the top-level parser owns every `--flag`, and a
 * field that shares a name with a global switch (`--json`, `--yolo`, `--all`)
 * would be read as that switch. Values are coerced by the property's declared
 * type — string, integer/number, boolean (`--flag`, `--no-flag`,
 * `--flag=false`), array (repeat the flag, or pass a JSON array), object (JSON).
 * Enums, ranges and required fields are left to the executor's schema
 * validation, which reports them as invalid input.
 */
export function parseSchemaArgs(
  tokens: readonly string[],
  schema: JSONSchema | undefined,
): Record<string, unknown> {
  const properties = (schema?.properties ?? {}) as Record<string, JSONSchema>;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--') || token === '--') {
      throw new ToolsCliUsageError(
        `unexpected argument "${token}" — tool fields are passed as --<field> <value>`,
      );
    }
    const eq = token.indexOf('=');
    let key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let inline: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);
    let field = resolveField(key, properties);
    if (!field && key.startsWith('no-') && inline === undefined) {
      const negated = resolveField(key.slice(3), properties);
      if (negated && primaryType(negated.schema) === 'boolean') {
        field = negated;
        key = key.slice(3);
        inline = 'false';
      }
    }
    if (!field) {
      const names = Object.keys(properties);
      throw new ToolsCliUsageError(
        `unknown input field --${key}${names.length > 0 ? ` (fields: ${names.join(', ')})` : ''}`,
      );
    }
    const type = primaryType(field.schema);
    let value = inline;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (type === 'boolean' && (next === undefined || next.startsWith('--'))) value = 'true';
      else if (next === undefined || next.startsWith('--')) {
        throw new ToolsCliUsageError(`--${key} needs a value`);
      } else {
        value = next;
        i++;
      }
    }
    const coerced = coerce(value, field.schema, `--${key}`);
    if (type === 'array' && !value.trim().startsWith('[')) {
      const prior = out[field.name];
      out[field.name] = Array.isArray(prior) ? [...prior, ...(coerced as unknown[])] : coerced;
    } else {
      out[field.name] = coerced;
    }
  }
  return out;
}

export interface BatchCall {
  /** 1-based line number in the batch input. */
  line: number;
  id?: unknown;
  tool: string;
  input: Record<string, unknown>;
}

export type BatchLine = BatchCall | { line: number; id?: unknown; error: string };

/**
 * JSONL batch: one `{"tool": "...", "input": {...}, "id"?: any}` per line.
 * Blank lines are skipped. A malformed line becomes an error entry rather than
 * aborting the batch, so every other call still reports; only exceeding
 * {@link TOOLS_CLI_MAX_BATCH_CALLS} rejects the batch as a whole.
 */
export function parseBatchLines(text: string): BatchLine[] {
  const entries: BatchLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]?.trim() ?? '';
    if (raw === '') continue;
    const line = index + 1;
    if (entries.length >= TOOLS_CLI_MAX_BATCH_CALLS) {
      throw new ToolsCliUsageError(
        `batch has more than ${TOOLS_CLI_MAX_BATCH_CALLS} calls; split it into several runs`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      entries.push({ line, error: `line ${line} is not valid JSON: ${toErrorMessage(err)}` });
      continue;
    }
    if (!isPlainObject(parsed)) {
      entries.push({ line, error: `line ${line} must be a JSON object, not ${kindOf(parsed)}` });
      continue;
    }
    const id = parsed['id'];
    const tool = parsed['tool'];
    const input = parsed['input'] ?? {};
    if (typeof tool !== 'string' || tool === '') {
      entries.push({ line, id, error: `line ${line} needs a "tool" name` });
    } else if (!isPlainObject(input)) {
      entries.push({ line, id, error: `line ${line}: "input" must be a JSON object` });
    } else {
      entries.push({ line, id, tool, input });
    }
  }
  return entries;
}

export async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.byteLength;
    if (total > maxBytes) throw new ToolsCliUsageError(`stdin input larger than ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveField(
  key: string,
  properties: Record<string, JSONSchema>,
): { name: string; schema: JSONSchema } | undefined {
  if (Object.hasOwn(properties, key)) return { name: key, schema: properties[key] ?? {} };
  // `--max-results` for a `maxResults` or `max_results` field.
  const camel = key.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  if (Object.hasOwn(properties, camel)) return { name: camel, schema: properties[camel] ?? {} };
  const snake = key.replace(/-/g, '_');
  if (Object.hasOwn(properties, snake)) return { name: snake, schema: properties[snake] ?? {} };
  return undefined;
}

function primaryType(schema: JSONSchema): string | undefined {
  const type = (schema as { type?: unknown }).type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type))
    return type.find((t): t is string => typeof t === 'string' && t !== 'null');
  return undefined;
}

function coerce(value: string, schema: JSONSchema, label: string): unknown {
  switch (primaryType(schema)) {
    case 'string':
      return value;
    case 'integer':
    case 'number': {
      const n = Number(value);
      const integer = primaryType(schema) === 'integer';
      if (value.trim() === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
        throw new ToolsCliUsageError(
          `${label} expects ${integer ? 'an integer' : 'a number'}, got "${value}"`,
        );
      }
      return n;
    }
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new ToolsCliUsageError(`${label} expects true or false, got "${value}"`);
    case 'array': {
      if (value.trim().startsWith('[')) return parseJsonValue(value, label);
      const items = ((schema as { items?: JSONSchema }).items ?? {}) as JSONSchema;
      return [coerce(value, items, label)];
    }
    case 'object':
      return parseJsonValue(value, label);
    default: {
      // Untyped / union field: take JSON when it parses, else the raw string.
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
  }
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new ToolsCliUsageError(`${label} expects JSON: ${toErrorMessage(err)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
