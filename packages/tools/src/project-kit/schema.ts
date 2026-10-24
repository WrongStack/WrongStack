import type { JSONSchema } from '@wrongstack/contracts/types';
import { validateAgainstSchema } from '@wrongstack/core/utils';

// Deliberately narrow, enforced subset. Unsupported keywords are errors rather
// than silently accepted promises. Defaults are applied only to object fields.
const keywords = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'default',
]);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function checkSchema(
  value: unknown,
  location = 'schema',
  depth = 0,
): asserts value is JSONSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 16) {
    throw new Error(`${location}: expected a schema object (maximum depth 16)`);
  }
  const schema = value as JSONSchema;
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key)) throw new Error(`${location}: unsupported keyword ${key}`);
  }
  if (!types.has(schema.type ?? ''))
    throw new Error(`${location}: explicit supported type required`);
  if (schema.description !== undefined && typeof schema.description !== 'string')
    throw new Error(`${location}: invalid description`);
  if (schema.type === 'object') {
    if (
      !schema.properties ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties)
    )
      throw new Error(`${location}: properties required`);
    if (schema.additionalProperties !== false)
      throw new Error(`${location}: additionalProperties must be false`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error(`${location}: reserved property ${key}`);
      checkSchema(child, `${location}.${key}`, depth + 1);
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key) => typeof key !== 'string' || !Object.hasOwn(schema.properties ?? {}, key),
        ))
    )
      throw new Error(`${location}: invalid required properties`);
  } else if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    throw new Error(`${location}: object keywords require object type`);
  }
  if (schema.type === 'array') checkSchema(schema.items, `${location}.items`, depth + 1);
  else if (schema.items !== undefined) throw new Error(`${location}: items requires array type`);
  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ] as const) {
    const n = schema[key];
    if (n === undefined) continue;
    const numeric = key === 'minimum' || key === 'maximum';
    const applicable = numeric
      ? ['number', 'integer'].includes(schema.type ?? '')
      : key.endsWith('Length')
        ? schema.type === 'string'
        : schema.type === 'array';
    if (
      !applicable ||
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      (!numeric && (!Number.isInteger(n) || n < 0))
    )
      throw new Error(`${location}: invalid ${key}`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length))
    throw new Error(`${location}: enum must be nonempty`);
  if (Object.hasOwn(schema, 'default')) assertValue(schema.default, schema, `${location}.default`);
}

export function assertValue(value: unknown, schema: JSONSchema, location: string): void {
  const result = validateAgainstSchema(value, schema);
  // Error messages deliberately omit values: parameters can contain secrets.
  if (!result.ok)
    throw new Error(
      `${location}: schema validation failed at ${result.errors.map((e) => e.path || '<root>').join(', ')}`,
    );
}

export function withDefaults(value: unknown, schema: JSONSchema): unknown {
  if (schema.type === 'array' && Array.isArray(value) && schema.items)
    return value.map((v) => withDefaults(v, schema.items as JSONSchema));
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value))
    return value;
  const result: Record<string, unknown> = { ...value };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(result, key) && Object.hasOwn(child, 'default'))
      result[key] = structuredClone(child.default);
    if (Object.hasOwn(result, key)) result[key] = withDefaults(result[key], child);
  }
  return result;
}
