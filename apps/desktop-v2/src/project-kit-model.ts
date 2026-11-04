import type { JSONSchema } from '@wrongstack/contracts/types';

export type KitSchema = JSONSchema;
export function kitInitialValue(schema: KitSchema): unknown {
  if (Object.hasOwn(schema, 'default')) return structuredClone(schema.default);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {})
          .filter(
            ([name, child]) => schema.required?.includes(name) || Object.hasOwn(child, 'default'),
          )
          .map(([name, child]) => [name, kitInitialValue(child)]),
      );
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'number':
      return schema.minimum ?? 0;
    case 'integer':
      return Math.ceil(schema.minimum ?? 0);
    default:
      return '';
  }
}

/** English wording of the kit form feedback; the desktop passes the display-language catalog. */
const KIT_INPUT_ERRORS = {
  choose: '{{path}}: choose a listed value.',
  object: '{{path}}: expected an object.',
  required: '{{path}}: required.',
  unknown: '{{path}}: unknown parameter.',
  list: '{{path}}: expected a list.',
  minItems: '{{path}}: at least {{value}} items.',
  maxItems: '{{path}}: at most {{value}} items.',
  finiteNumber: '{{path}}: enter a finite number.',
  finiteInteger: '{{path}}: enter a finite integer.',
  minimum: '{{path}}: minimum {{value}}.',
  maximum: '{{path}}: maximum {{value}}.',
  text: '{{path}}: expected text.',
  minLength: '{{path}}: at least {{value}} characters.',
  maxLength: '{{path}}: at most {{value}} characters.',
  boolean: '{{path}}: choose yes or no.',
  empty: '{{path}}: expected an empty value.',
  unsupported: '{{path}}: unsupported parameter type.',
} as const;
export type KitInputError = keyof typeof KIT_INPUT_ERRORS;
export type KitSay = (code: KitInputError, values: { path: string; value?: number }) => string;
const english: KitSay = (code, values) =>
  KIT_INPUT_ERRORS[code]
    .replace('{{path}}', () => values.path)
    .replace('{{value}}', () => String(values.value));

/** Form feedback for the supported kit schema subset; the engine remains authoritative. */
export function kitInputErrors(
  schema: KitSchema,
  value: unknown,
  path = 'Input',
  say: KitSay = english,
): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((item) => kitValuesEqual(item, value)))
    errors.push(say('choose', { path }));
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return [say('object', { path })];
      const object = value as Record<string, unknown>;
      for (const name of schema.required ?? [])
        if (!Object.hasOwn(object, name)) errors.push(say('required', { path: `${path}.${name}` }));
      for (const [name, item] of Object.entries(object)) {
        const child = Object.hasOwn(schema.properties ?? {}, name)
          ? schema.properties?.[name]
          : undefined;
        if (child) errors.push(...kitInputErrors(child, item, `${path}.${name}`, say));
        else errors.push(say('unknown', { path: `${path}.${name}` }));
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) return [say('list', { path })];
      if (schema.minItems !== undefined && value.length < schema.minItems)
        errors.push(say('minItems', { path, value: schema.minItems }));
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        errors.push(say('maxItems', { path, value: schema.maxItems }));
      if (schema.items)
        value.forEach((item, i) => {
          errors.push(...kitInputErrors(schema.items as KitSchema, item, `${path}[${i + 1}]`, say));
        });
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value))
      )
        return [say(schema.type === 'integer' ? 'finiteInteger' : 'finiteNumber', { path })];
      if (schema.minimum !== undefined && value < schema.minimum)
        errors.push(say('minimum', { path, value: schema.minimum }));
      if (schema.maximum !== undefined && value > schema.maximum)
        errors.push(say('maximum', { path, value: schema.maximum }));
      break;
    case 'string':
      if (typeof value !== 'string') return [say('text', { path })];
      if (schema.minLength !== undefined && value.length < schema.minLength)
        errors.push(say('minLength', { path, value: schema.minLength }));
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        errors.push(say('maxLength', { path, value: schema.maxLength }));
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(say('boolean', { path }));
      break;
    case 'null':
      if (value !== null) errors.push(say('empty', { path }));
      break;
    default:
      errors.push(say('unsupported', { path }));
  }
  return errors;
}

export function kitValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => kitValuesEqual(item, right[index]))
    );
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && kitValuesEqual(a[key], b[key]))
  );
}

export function kitRequest(
  name: string,
  revision: string,
  action: 'verify' | 'run',
  input: unknown,
): string {
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(name) ||
    name.length > 80 ||
    !/^[a-f0-9]{64}$/.test(revision)
  )
    throw Error('Refresh the kit before preparing a request.');
  return `Use project_kit_run with the following parameters. Inspect the kit and follow the normal permission flow before executing. Do not substitute a different revision.\n\n${JSON.stringify({ action, name, revision, ...(action === 'run' ? { input } : {}) }, null, 2)}`;
}
