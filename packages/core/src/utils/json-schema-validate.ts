/**
 * Minimal JSON Schema validator — covers the subset needed for plugin
 * configSchema validation and tool inputSchema sanity checks. Intentionally
 * small (~80 lines, zero deps) and tolerant: unknown keywords are ignored so
 * authors can mix in non-standard extensions without breaking validation.
 *
 * NOT for full JSON Schema 2020-12 conformance. If a plugin needs $ref,
 * conditional schemas, format validation, or anything else exotic, it should
 * bring its own ajv-based validator and call this only for the cheap path.
 */
import type { JSONSchema } from '../types/tool.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

export function validateAgainstSchema(value: unknown, schema: JSONSchema): ValidationResult {
  const errors: ValidationError[] = [];
  walk(value, schema, '', errors, 0);
  return { ok: errors.length === 0, errors };
}

/**
 * Maximum nesting depth before the validator stops recursing and reports a
 * "schema too deep" error. Deeply nested input (e.g. batch_tool_use with 100
 * nested calls → tool_use → input) can otherwise hit `RangeError: Maximum
 * call stack size exceeded` and crash the tool executor.
 *
 * 64 is generous: real-world tool schemas rarely nest beyond 5-6 levels, and
 * even pathological inputs (deeply recursive JSON) stay well under this.
 * The limit is a safety net against unbounded recursion, not a tight bound.
 */
const MAX_SCHEMA_DEPTH = 64;

function walk(
  value: unknown,
  schema: JSONSchema,
  path: string,
  errors: ValidationError[],
  depth: number,
): void {
  // P2 #8 (before-release.md): cap recursion depth to prevent
  // `RangeError: Maximum call stack size exceeded` on deeply nested input.
  // Push a validation error and stop descending — the caller still gets a
  // usable (ok: false) result instead of a crash.
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push({
      path: path || '<root>',
      message: `schema nesting exceeds maximum depth (${MAX_SCHEMA_DEPTH})`,
    });
    return;
  }
  if (schema.enum !== undefined) {
    if (!enumIncludes(schema.enum, value)) {
      errors.push({
        path: path || '<root>',
        message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
      });
      return;
    }
  }

  if (typeof schema.type === 'string') {
    if (!checkType(value, schema.type)) {
      errors.push({
        path: path || '<root>',
        message: `expected ${schema.type}, got ${describeType(value)} (${previewValue(value)})`,
      });
      return;
    }
  }

  if (schema.type === 'object' && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) {
        const expected = schema.properties?.[req]?.type;
        errors.push({
          path: joinPath(path, req),
          message: `required property missing${typeof expected === 'string' ? ` (expected ${expected})` : ''}`,
        });
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          walk(obj[key], subSchema, joinPath(path, key), errors, depth + 1);
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], schema.items as JSONSchema, `${path}[${i}]`, errors, depth + 1);
    }
  }
}

export interface CoercionResult {
  value: unknown;
  /** True when at least one leaf was rewritten. */
  changed: boolean;
}

/**
 * Best-effort, lossless coercion of a value toward a JSON Schema. Models —
 * especially through OpenAI-compatible proxies — frequently deliver
 * arguments with the right *content* in the wrong *type*: numbers and
 * booleans encoded as strings ("5", "true"), scalars where a string is
 * expected, or a whole nested object serialized into a JSON string.
 *
 * Only conversions that cannot lose information are applied:
 *   - string → number/integer when the whole trimmed string parses cleanly
 *   - string "true"/"false" → boolean
 *   - number/boolean → string when a string is expected
 *   - JSON-serialized string → object/array when the parse yields that shape
 * Recurses into `properties`/`items`. Returns the (possibly new) value and
 * whether anything changed — callers should re-validate before trusting it.
 */
export function coerceAgainstSchema(value: unknown, schema: JSONSchema): CoercionResult {
  return coerceWalk(value, schema, 0);
}

function coerceWalk(value: unknown, schema: JSONSchema, depth: number): CoercionResult {
  if (depth > MAX_SCHEMA_DEPTH) return { value, changed: false };

  const type = typeof schema.type === 'string' ? schema.type : undefined;

  // Leaf conversions (only when the current type does NOT already match).
  if (type && !checkType(value, type)) {
    if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      return { value: String(value), changed: true };
    }
    if ((type === 'number' || type === 'integer') && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isFinite(num) && (type === 'number' || Number.isInteger(num))) {
          return { value: num, changed: true };
        }
      }
      return { value, changed: false };
    }
    if (type === 'boolean' && typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true') return { value: true, changed: true };
      if (lowered === 'false') return { value: false, changed: true };
      return { value, changed: false };
    }
    if ((type === 'object' || type === 'array') && typeof value === 'string') {
      // A nested structure serialized into a string (double-encoded args).
      try {
        const parsed: unknown = JSON.parse(value);
        if (checkType(parsed, type)) {
          // Recurse so leaves inside the revived structure also coerce.
          return { value: coerceWalk(parsed, schema, depth + 1).value, changed: true };
        }
      } catch {
        // fall through — leave as-is, validation will report it
      }
      return { value, changed: false };
    }
    return { value, changed: false };
  }

  // Structural recursion.
  if (type === 'object' && isPlainObject(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = { ...obj };
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (!(key in obj)) continue;
      const r = coerceWalk(obj[key], subSchema, depth + 1);
      if (r.changed) {
        out[key] = r.value;
        changed = true;
      }
    }
    return changed ? { value: out, changed } : { value, changed: false };
  }

  if (type === 'array' && Array.isArray(value) && schema.items) {
    let changed = false;
    const out = value.map((item) => {
      const r = coerceWalk(item, schema.items as JSONSchema, depth + 1);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed } : { value, changed: false };
  }

  return { value, changed: false };
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return true;
  }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Short serialized preview of the offending value for error messages. */
function previewValue(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return String(v);
  }
}

function joinPath(parent: string, key: string): string {
  if (!parent) return key;
  return `${parent}.${key}`;
}

function enumIncludes(values: readonly unknown[], value: unknown): boolean {
  if (value === null || typeof value !== 'object') return values.includes(value);
  return values.some((candidate) => deepEqual(candidate, value));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
