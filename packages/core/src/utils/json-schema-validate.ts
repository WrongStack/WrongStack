/**
 * Minimal JSON Schema validator — covers the subset needed for plugin
 * configSchema validation and tool inputSchema sanity checks. Zero deps and
 * tolerant: unknown keywords are ignored so authors can mix in non-standard
 * extensions without breaking validation.
 *
 * Enforced (2026-09-11 contract chain): type, enum, required,
 * properties/patternProperties/additionalProperties (boolean-false and
 * subschema forms), items, minimum/maximum, minLength/maxLength, pattern,
 * minItems/maxItems/uniqueItems, and the allOf/anyOf/oneOf combinators —
 * including object keywords applied to object instances without a declared
 * `type` (the anyOf/oneOf/allOf `required` conditionals in production
 * schemas rely on it). `const` and `$ref` are deliberately NOT enforced
 * (2026-09-11 usage survey: zero shared-validator surface — the techstack
 * rulebook is the only declarer and validates with its own
 * `validateRulebook`).
 *
 * NOT for full JSON Schema 2020-12 conformance: format, if/then/else,
 * unevaluated*, and dependency keywords are still ignored. If a plugin needs
 * those, it should bring its own ajv-based validator and call this only for
 * the cheap path.
 */
import type { JSONSchema } from '@wrongstack/contracts/types/tool';
import { patternIsLikelyCatastrophic } from './json-schema-pattern-safety.js';

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

/**
 * Safe pattern-check length: strings longer than this are not regex-tested.
 * A `pattern` over bulk content is a schema smell — bulk content is bounded
 * by maxLength and format-checked by the tool itself; executing an
 * author-supplied regex over unbounded model-supplied text is the ReDoS
 * vector this gate bounds (see patternIsLikelyCatastrophic).
 */
const MAX_PATTERN_CHECK_LENGTH = 10_000;

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

  // Numeric bounds. JSON Schema applies minimum/maximum to numbers only, and
  // only when the value actually is one — production schemas declare them
  // (telegram maxMessageLength 100..4096, mcp limit 1..500, lsp limit
  // 1..100), and ignoring them let out-of-range config and tool input pass.
  // Skipped when the type check above already failed (it returned).
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path: path || '<root>',
        message: `expected number >= ${schema.minimum}, got ${value}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path: path || '<root>',
        message: `expected number <= ${schema.maximum}, got ${value}`,
      });
    }
  }

  // String lengths. JSON Schema applies minLength/maxLength to strings only,
  // measured in UTF-16 code units (String.length). Production tool schemas
  // declare them (plug-lsp completion content <= 500_000, telegram-approve
  // prompt <= 200 / details <= 1000, sage and vector-memory text/query
  // >= 1, template-engine caps); ignoring them let oversized and empty
  // strings pass every gate. Skipped when the type check above already
  // failed (it returned).
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path: path || '<root>',
        message: `expected string length >= ${schema.minLength}, got ${value.length}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path: path || '<root>',
        message: `expected string length <= ${schema.maxLength}, got ${value.length}`,
      });
    }
    // String pattern (regex). Two safety gates run before the regex ever
    // executes against a model-supplied value: (1) a static shape check —
    // ambiguous repetition (an unboundedly-quantified group whose body
    // contains another quantifier or an alternation, e.g. (a+)+, (a|aa)+,
    // (\d{2,3})+) is the shape behind catastrophic backtracking, rejected
    // with a distinct error so the schema author restructures; (2) a length
    // cap bounding residual exposure for shapes the static check cannot
    // prove safe. Invalid regexes are still skipped tolerantly (consistent
    // with patternProperties). Production: browser tools secretEnv
    // '^[A-Z_][A-Z0-9_]*$'.
    if (schema.pattern !== undefined) {
      if (patternIsLikelyCatastrophic(schema.pattern)) {
        errors.push({
          path: path || '<root>',
          message:
            'pattern unsafe: quantified group with a nested quantifier or alternation can cause catastrophic backtracking — restructure the pattern',
        });
      } else if (value.length > MAX_PATTERN_CHECK_LENGTH) {
        errors.push({
          path: path || '<root>',
          message: `pattern not checked: string exceeds safe pattern-check length (${MAX_PATTERN_CHECK_LENGTH}), got ${value.length}`,
        });
      } else {
        try {
          if (!new RegExp(schema.pattern).test(value)) {
            errors.push({
              path: path || '<root>',
              message: `expected string matching ${schema.pattern}, got ${previewValue(value)}`,
            });
          }
        } catch {
          // Invalid regex: skip, consistent with patternProperties handling.
        }
      }
    }
  }

  // Array lengths. JSON Schema applies minItems/maxItems/uniqueItems to
  // arrays only. Production tool schemas declare them (clarify options
  // 2..6, browser files 1..20, next-steps steps >= 1, kanban subtasks >= 2,
  // mailbox-mcp ack batch maxItems + capabilities uniqueItems,
  // council/subagent-result caps).
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path: path || '<root>',
        message: `expected array length >= ${schema.minItems}, got ${value.length}`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path: path || '<root>',
        message: `expected array length <= ${schema.maxItems}, got ${value.length}`,
      });
    }
    if (schema.uniqueItems === true && arrayHasDuplicates(value)) {
      errors.push({
        path: path || '<root>',
        message: 'expected unique array items (uniqueItems: true)',
      });
    }
  }

  if (isPlainObject(value) && hasObjectKeywords(schema)) {
    const obj = value as Record<string, unknown>;
    // Own properties only: `in` sees Object.prototype, so `required:
    // ["toString"]` passed for `{}` and an omitted optional `constructor`
    // was validated against the inherited `Object` function.
    for (const req of schema.required ?? []) {
      if (!Object.hasOwn(obj, req)) {
        const expected = schema.properties?.[req]?.type;
        errors.push({
          path: joinPath(path, req),
          message: `required property missing${typeof expected === 'string' ? ` (expected ${expected})` : ''}`,
        });
      }
    }
    // Property-governing keywords beyond `properties`. JSON Schema: a key is
    // governed by `properties` (exact match), by every matching
    // `patternProperties` pattern, and by `additionalProperties` only when
    // neither of those applies. The `false` form (round-2 enforcement) and
    // the subschema form are mutually exclusive by value type. Production
    // subschema schemas: template-engine variables (map-of-strings) and
    // cost-tracker pricingOverrides (map-of-pricing objects whose inner
    // required/closed constraints were inert until this walk existed).
    // `additionalProperties: true` stays explicitly open. Object keywords
    // apply to object instances even without a declared `type` (JSON
    // Schema) — the anyOf/oneOf/allOf `required` conditionals in
    // production schemas (migration-planner, semantic-search-indexer)
    // depend on it.
    const known = new Set(Object.keys(schema.properties ?? {}));
    const patternSchemas: Array<{ re: RegExp; sub: JSONSchema }> = [];
    for (const [pattern, sub] of Object.entries(schema.patternProperties ?? {})) {
      // Same gate as `pattern`: these author regexes run over model-supplied
      // property NAMES, so a catastrophic shape would wedge the process.
      if (patternIsLikelyCatastrophic(pattern)) {
        errors.push({
          path: path || '<root>',
          message: `patternProperties ${JSON.stringify(pattern)} unsafe: quantified group with a nested quantifier or alternation can cause catastrophic backtracking — restructure the pattern`,
        });
        continue;
      }
      try {
        patternSchemas.push({ re: new RegExp(pattern), sub: sub as JSONSchema });
      } catch {
        // Author-supplied invalid regex: skip it (tolerant, consistent with
        // unknown-keyword handling) rather than crash validation.
      }
    }
    for (const key of Object.keys(obj)) {
      const nameTooLong = patternSchemas.length > 0 && key.length > MAX_PATTERN_CHECK_LENGTH;
      if (nameTooLong) {
        errors.push({
          path: path || '<root>',
          message: `patternProperties not checked: property name exceeds safe pattern-check length (${MAX_PATTERN_CHECK_LENGTH}), got ${key.length}`,
        });
      }
      const matches = nameTooLong ? [] : patternSchemas.filter((p) => p.re.test(key));
      if (!known.has(key) && matches.length === 0) {
        if (schema.additionalProperties === false) {
          errors.push({
            path: joinPath(path, key),
            message: 'unknown property (additionalProperties: false)',
          });
        } else if (isPlainObject(schema.additionalProperties)) {
          walk(
            obj[key],
            schema.additionalProperties as JSONSchema,
            joinPath(path, key),
            errors,
            depth + 1,
          );
        }
      }
      for (const p of matches) {
        walk(obj[key], p.sub, joinPath(path, key), errors, depth + 1);
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(obj, key)) {
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

  // Combinators, evaluated after the instance's own keyword errors so the
  // specific cause is reported first. allOf: every subschema applies
  // (errors flow directly). anyOf: at least one trial passes. oneOf:
  // exactly one passes. Trials walk into scratch lists so failed variants
  // do not pollute the reported errors. Production: telegram chat_id
  // (oneOf string|integer), director worktree overrides (anyOf
  // boolean|enum), shell-check files (anyOf array|string),
  // migration-planner / semantic-search-indexer allOf+anyOf `required`
  // conditionals.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      walk(value, sub as JSONSchema, path, errors, depth + 1);
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword];
    if (!Array.isArray(options)) continue;
    let passing = 0;
    let firstFailure: string | undefined;
    for (const sub of options as JSONSchema[]) {
      const trial: ValidationError[] = [];
      walk(value, sub, path, trial, depth + 1);
      if (trial.length === 0) {
        passing++;
        if (keyword === 'anyOf') break;
      } else if (firstFailure === undefined) {
        firstFailure = trial[0]?.message ?? 'invalid';
      }
    }
    const satisfied = keyword === 'anyOf' ? passing >= 1 : passing === 1;
    if (!satisfied) {
      errors.push({
        path: path || '<root>',
        message:
          keyword === 'anyOf'
            ? `expected at least one of ${options.length} anyOf variants to match${
                firstFailure ? ` (first: ${firstFailure})` : ''
              }`
            : `expected exactly one of ${options.length} oneOf variants to match, got ${passing}`,
      });
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
        if (Number.isFinite(num) && (type === 'number' || Number.isSafeInteger(num))) {
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
      return typeof value === 'number' && Number.isFinite(value);
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

/**
 * Object keywords apply to object instances regardless of a declared
 * `type` (JSON Schema): production anyOf/oneOf/allOf subschemas like
 * `{ required: ['query'] }` (semantic-search-indexer, migration-planner)
 * carry constraints without declaring `type: 'object'`.
 */
function hasObjectKeywords(schema: JSONSchema): boolean {
  return (
    schema.type === 'object' ||
    schema.required !== undefined ||
    schema.properties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.additionalProperties !== undefined
  );
}

/**
 * uniqueItems check: primitives dedupe via Set (O(n)); object/array items
 * compare pairwise with deepEqual (bounded in practice by declared
 * maxItems caps).
 */
function arrayHasDuplicates(items: readonly unknown[]): boolean {
  const primitives = new Set<unknown>();
  const objects: unknown[] = [];
  for (const item of items) {
    if (item !== null && typeof item === 'object') {
      objects.push(item);
    } else if (primitives.has(item)) {
      return true;
    } else {
      primitives.add(item);
    }
  }
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (deepEqual(objects[i], objects[j])) return true;
    }
  }
  return false;
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
