import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '../../src/types/tool.js';
import {
  coerceAgainstSchema,
  validateAgainstSchema,
} from '../../src/utils/json-schema-validate.js';

describe('json-schema-validate / validateAgainstSchema', () => {
  describe('primitive types', () => {
    it('accepts a matching string', () => {
      const r = validateAgainstSchema('hello', { type: 'string' });
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('rejects wrong primitive type', () => {
      const r = validateAgainstSchema(42, { type: 'string' });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/expected string, got number/);
      expect(r.errors[0]!.path).toBe('<root>');
    });

    it('accepts number', () => {
      expect(validateAgainstSchema(3.14, { type: 'number' }).ok).toBe(true);
    });

    it('rejects NaN for number', () => {
      expect(validateAgainstSchema(Number.NaN, { type: 'number' }).ok).toBe(false);
    });

    it('accepts integer for integer type', () => {
      expect(validateAgainstSchema(7, { type: 'integer' }).ok).toBe(true);
    });

    it('rejects float for integer type', () => {
      expect(validateAgainstSchema(7.5, { type: 'integer' }).ok).toBe(false);
    });

    it('accepts boolean', () => {
      expect(validateAgainstSchema(true, { type: 'boolean' }).ok).toBe(true);
      expect(validateAgainstSchema(false, { type: 'boolean' }).ok).toBe(true);
    });

    it('accepts null only for null type', () => {
      expect(validateAgainstSchema(null, { type: 'null' }).ok).toBe(true);
      expect(validateAgainstSchema(undefined, { type: 'null' }).ok).toBe(false);
    });

    it('distinguishes array from object', () => {
      expect(validateAgainstSchema([], { type: 'array' }).ok).toBe(true);
      expect(validateAgainstSchema([], { type: 'object' }).ok).toBe(false);
      expect(validateAgainstSchema({}, { type: 'object' }).ok).toBe(true);
      expect(validateAgainstSchema({}, { type: 'array' }).ok).toBe(false);
    });

    it('reports describeType correctly for null and arrays', () => {
      const r1 = validateAgainstSchema(null, { type: 'string' });
      expect(r1.errors[0]!.message).toMatch(/got null/);
      const r2 = validateAgainstSchema([], { type: 'string' });
      expect(r2.errors[0]!.message).toMatch(/got array/);
    });
  });

  describe('object properties', () => {
    it('reports missing required keys', () => {
      const schema: JSONSchema = {
        type: 'object',
        required: ['name', 'age'],
        properties: { name: { type: 'string' }, age: { type: 'number' } },
      };
      const r = validateAgainstSchema({ name: 'a' }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.path).toBe('age');
      expect(r.errors[0]!.message).toMatch(/required/);
    });

    it('validates each declared property', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'number' } },
      };
      const r = validateAgainstSchema({ name: 1, age: 'x' }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(2);
      expect(r.errors.map((e) => e.path).sort()).toEqual(['age', 'name']);
    });

    it('ignores unknown properties (open by default)', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };
      const r = validateAgainstSchema({ name: 'a', extra: 123 }, schema);
      expect(r.ok).toBe(true);
    });

    it('uses dotted paths for nested errors', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: {
          inner: {
            type: 'object',
            properties: { x: { type: 'number' } },
          },
        },
      };
      const r = validateAgainstSchema({ inner: { x: 'no' } }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('inner.x');
    });

    it('does not walk properties when value is not an object', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      const r = validateAgainstSchema('not an object', schema);
      expect(r.ok).toBe(false);
      // First type mismatch short-circuits; no `name required missing` error.
      expect(r.errors).toHaveLength(1);
    });
  });

  describe('array items', () => {
    it('validates each item against schema', () => {
      const schema: JSONSchema = { type: 'array', items: { type: 'number' } };
      const r = validateAgainstSchema([1, 'two', 3], schema);
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.path).toBe('[1]');
    });

    it('accepts empty array', () => {
      const r = validateAgainstSchema([], { type: 'array', items: { type: 'number' } });
      expect(r.ok).toBe(true);
    });

    it('flags multiple bad items separately', () => {
      const schema: JSONSchema = { type: 'array', items: { type: 'number' } };
      const r = validateAgainstSchema(['a', 'b'], schema);
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(2);
      expect(r.errors.map((e) => e.path)).toEqual(['[0]', '[1]']);
    });
  });

  describe('enum', () => {
    it('accepts a listed primitive', () => {
      const r = validateAgainstSchema('red', { enum: ['red', 'green', 'blue'] });
      expect(r.ok).toBe(true);
    });

    it('rejects a value not in the list', () => {
      const r = validateAgainstSchema('yellow', { enum: ['red', 'green', 'blue'] });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/expected one of/);
    });

    it('uses deep equality for objects', () => {
      const r = validateAgainstSchema({ a: 1, b: 2 }, { enum: [{ a: 1, b: 2 }] });
      expect(r.ok).toBe(true);
    });

    it('uses deep equality for arrays', () => {
      const r = validateAgainstSchema([1, 2, 3], { enum: [[1, 2, 3]] });
      expect(r.ok).toBe(true);
      const r2 = validateAgainstSchema([1, 2], { enum: [[1, 2, 3]] });
      expect(r2.ok).toBe(false);
    });

    it('short-circuits on enum mismatch (no further checks)', () => {
      const r = validateAgainstSchema(42, { enum: [1, 2], type: 'string' });
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(/expected one of/);
    });
  });

  describe('unknown / extensible keywords', () => {
    it('ignores unknown type identifiers', () => {
      const r = validateAgainstSchema('anything', { type: 'made-up-type' as never });
      expect(r.ok).toBe(true);
    });

    it('accepts a schema with no constraints', () => {
      const r = validateAgainstSchema(42, {});
      expect(r.ok).toBe(true);
    });
  });

  describe('recursion depth limit (P2 #8)', () => {
    // Build a deeply nested object schema { a: { a: { a: ... } } } and a
    // matching value, then assert the validator does NOT crash with
    // RangeError and instead reports a clean validation error once the cap
    // is exceeded.

    function nestedObjectSchema(depth: number): JSONSchema {
      // { type: 'object', properties: { a: <depth-1 more levels> } }
      let schema: JSONSchema = { type: 'string' };
      for (let i = 0; i < depth; i++) {
        schema = { type: 'object', properties: { a: schema } };
      }
      return schema;
    }

    function nestedObjectValue(depth: number): unknown {
      let v: unknown = 'leaf';
      for (let i = 0; i < depth; i++) {
        v = { a: v };
      }
      return v;
    }

    function nestedArraySchema(depth: number): JSONSchema {
      let schema: JSONSchema = { type: 'string' };
      for (let i = 0; i < depth; i++) {
        schema = { type: 'array', items: schema };
      }
      return schema;
    }

    it('accepts normally-nested objects (depth well under the cap)', () => {
      const schema = nestedObjectSchema(10);
      const value = nestedObjectValue(10);
      const r = validateAgainstSchema(value, schema);
      expect(r.ok).toBe(true);
    });

    it('accepts normally-nested arrays (depth well under the cap)', () => {
      const schema = nestedArraySchema(10);
      let value: unknown = 'leaf';
      for (let i = 0; i < 10; i++) value = [value];
      const r = validateAgainstSchema(value, schema);
      expect(r.ok).toBe(true);
    });

    it('does NOT crash on a pathologically deep object (depth > 64)', () => {
      // Before the fix this hit `RangeError: Maximum call stack size exceeded`.
      const schema = nestedObjectSchema(200);
      const value = nestedObjectValue(200);
      // Must not throw — the validator caps recursion and returns a result.
      const r = validateAgainstSchema(value, schema);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.message.includes('maximum depth'))).toBe(true);
    });

    it('does NOT crash on a pathologically deep array (depth > 64)', () => {
      const schema = nestedArraySchema(200);
      let value: unknown = 'leaf';
      for (let i = 0; i < 200; i++) value = [value];
      const r = validateAgainstSchema(value, schema);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.message.includes('maximum depth'))).toBe(true);
    });
  });

  describe('numeric bounds (minimum/maximum)', () => {
    // Regression: walk() ignored minimum/maximum, so out-of-range numbers
    // passed validation. That gap let a configured telegram maxMessageLength
    // of 0 through its declared minimum:100 and enabled the 2026-09-10
    // truncateForTelegram degenerate-cap bug.

    it('rejects below minimum', () => {
      const r = validateAgainstSchema(0, { type: 'number', minimum: 100, maximum: 4096 });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('<root>');
      expect(r.errors[0]!.message).toMatch(/expected number >= 100, got 0/);
    });

    it('rejects above maximum', () => {
      const r = validateAgainstSchema(4097, { type: 'number', minimum: 100, maximum: 4096 });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/expected number <= 4096, got 4097/);
    });

    it('accepts exact minimum and maximum (inclusive bounds)', () => {
      const schema: JSONSchema = { type: 'number', minimum: 1, maximum: 500 };
      expect(validateAgainstSchema(1, schema).ok).toBe(true);
      expect(validateAgainstSchema(500, schema).ok).toBe(true);
    });

    it('enforces bounds for integer type', () => {
      const schema: JSONSchema = { type: 'integer', minimum: 1, maximum: 100 };
      expect(validateAgainstSchema(0, schema).ok).toBe(false);
      expect(validateAgainstSchema(101, schema).ok).toBe(false);
      expect(validateAgainstSchema(1, schema).ok).toBe(true);
      expect(validateAgainstSchema(100, schema).ok).toBe(true);
    });

    it('reports the property path for nested config objects', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { maxMessageLength: { type: 'number', minimum: 100 } },
      };
      const r = validateAgainstSchema({ maxMessageLength: 0 }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('maxMessageLength');
      expect(r.errors[0]!.message).toMatch(/expected number >= 100, got 0/);
    });

    it('applies bounds when no type is declared', () => {
      expect(validateAgainstSchema(4, { minimum: 5 }).ok).toBe(false);
      expect(validateAgainstSchema(5, { minimum: 5 }).ok).toBe(true);
    });

    it('ignores bounds for non-numeric values (JSON Schema: numbers only)', () => {
      expect(validateAgainstSchema('abc', { type: 'string', minimum: 5 }).ok).toBe(true);
      expect(validateAgainstSchema('abc', { minimum: 5 }).ok).toBe(true);
      expect(validateAgainstSchema(null, { type: 'null', minimum: 5 }).ok).toBe(true);
    });
  });

  describe('strict-closed objects (additionalProperties: false)', () => {
    // Regression: walk() ignored `additionalProperties`, so objects carrying
    // unknown properties passed every gate (plugin config load, tool
    // executor, MCP tools/call) even when the schema declared strict-closed.

    it('rejects an unknown property at its own path', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { mode: { type: 'string' }, path: { type: 'string' } },
        additionalProperties: false,
      };
      const r = validateAgainstSchema({ mode: 'read', path: 'a', injected: 'yes' }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('injected');
      expect(r.errors[0]!.message).toMatch(/unknown property/);
    });

    it('reports every unknown key separately', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { a: { type: 'number' } },
        additionalProperties: false,
      };
      const r = validateAgainstSchema({ a: 1, foo: 1, bar: 2 }, schema);
      expect(r.errors.map((e) => e.path).sort()).toEqual(['bar', 'foo']);
    });

    it('accepts when every key is declared', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
      };
      expect(validateAgainstSchema({ a: 1 }, schema).ok).toBe(true);
    });

    it('rejects every key when properties is empty (closed-everything)', () => {
      const schema: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };
      const r = validateAgainstSchema({ anything: 1 }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('anything');
    });

    it('reports unknown keys inside nested closed objects at the nested path', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: {
          inner: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' } },
          },
        },
      };
      const r = validateAgainstSchema({ inner: { x: 1, injected: true } }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('inner.injected');
    });

    it('stays open by default when the keyword is absent', () => {
      const schema: JSONSchema = { type: 'object', properties: { name: { type: 'string' } } };
      expect(validateAgainstSchema({ name: 'a', extra: 123 }, schema).ok).toBe(true);
    });

    it('additionalProperties: true is explicitly open', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: true,
      };
      expect(validateAgainstSchema({ name: 'a', extra: 1 }, schema).ok).toBe(true);
    });

    it('enforces the subschema form (map-of-values, template-engine shape)', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { vars: { type: 'object', additionalProperties: { type: 'string' } } },
      };
      const r = validateAgainstSchema({ vars: { name: 'x', count: 123 } }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('vars.count');
      expect(r.errors[0]!.message).toMatch(/expected string/);
      expect(validateAgainstSchema({ vars: { name: 'x' } }, schema).ok).toBe(true);
    });

    it('non-object values are untouched (type check owns the error)', () => {
      const r = validateAgainstSchema('str', { type: 'object', additionalProperties: false });
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(/expected object/);
    });
  });

  describe('string lengths (minLength/maxLength)', () => {
    // Regression: walk() ignored minLength/maxLength, so length-violating
    // strings passed every gate. Real declaring schemas: plug-lsp completion
    // content <= 500_000, telegram-approve prompt <= 200 / details <= 1000,
    // sage and vector-memory text/query >= 1, template-engine caps.

    it('rejects above maxLength', () => {
      const r = validateAgainstSchema('x'.repeat(500_001), {
        type: 'string',
        maxLength: 500_000,
      });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('<root>');
      expect(r.errors[0]!.message).toMatch(/expected string length <= 500000, got 500001/);
    });

    it('rejects below minLength', () => {
      const r = validateAgainstSchema('', { type: 'string', minLength: 1 });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/expected string length >= 1, got 0/);
    });

    it('accepts exact boundaries (inclusive)', () => {
      expect(
        validateAgainstSchema('x'.repeat(500_000), { type: 'string', maxLength: 500_000 }).ok,
      ).toBe(true);
      expect(validateAgainstSchema('ab', { type: 'string', minLength: 2 }).ok).toBe(true);
    });

    it('enforces both bounds together', () => {
      const schema: JSONSchema = { type: 'string', minLength: 2, maxLength: 5 };
      expect(validateAgainstSchema('a', schema).ok).toBe(false);
      expect(validateAgainstSchema('abcdef', schema).ok).toBe(false);
      expect(validateAgainstSchema('abc', schema).ok).toBe(true);
    });

    it('reports the property path for nested objects', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { content: { type: 'string', maxLength: 10 } },
      };
      const r = validateAgainstSchema({ content: 'x'.repeat(11) }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('content');
      expect(r.errors[0]!.message).toMatch(/expected string length <= 10, got 11/);
    });

    it('ignores length keywords for non-string values (JSON Schema: strings only)', () => {
      expect(validateAgainstSchema(42, { minLength: 100 }).ok).toBe(true);
      expect(validateAgainstSchema(42, { maxLength: 1 }).ok).toBe(true);
    });

    it('type mismatch still owns the error (no length error for wrong type)', () => {
      const r = validateAgainstSchema(42, { type: 'string', minLength: 1 });
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(/expected string/);
    });
  });

  describe('patternProperties and additionalProperties subschema', () => {
    // Regression: walk() ignored the `additionalProperties` subschema form
    // and `patternProperties`. Real declaring schemas: template-engine
    // variables (map-of-strings) and cost-tracker pricingOverrides
    // (map-of-pricing objects with required input/output and a closed inner
    // schema that was entirely inert until the subschema walk existed).

    it('enforces the cost-tracker pricingOverrides subschema end to end', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: {
          pricingOverrides: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                input: { type: 'number', minimum: 0 },
                output: { type: 'number', minimum: 0 },
              },
              required: ['input', 'output'],
              additionalProperties: false,
            },
          },
        },
      };
      expect(
        validateAgainstSchema({ pricingOverrides: { gpt: { input: 1, output: 2 } } }, schema).ok,
      ).toBe(true);
      const missing = validateAgainstSchema({ pricingOverrides: { gpt: { input: 1 } } }, schema);
      expect(missing.ok).toBe(false);
      expect(missing.errors[0]!.path).toBe('pricingOverrides.gpt.output');
      const extra = validateAgainstSchema(
        { pricingOverrides: { gpt: { input: 1, output: 2, cacheWrite: 3 } } },
        schema,
      );
      expect(extra.ok).toBe(false);
      expect(extra.errors[0]!.path).toBe('pricingOverrides.gpt.cacheWrite');
    });

    it('applies patternProperties to matching keys only', () => {
      const schema: JSONSchema = {
        type: 'object',
        patternProperties: { '^x-': { type: 'number' } },
      };
      expect(validateAgainstSchema({ 'x-a': 1 }, schema).ok).toBe(true);
      const bad = validateAgainstSchema({ 'x-a': 'str' }, schema);
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]!.path).toBe('x-a');
      expect(validateAgainstSchema({ 'y-b': 'str' }, schema).ok).toBe(true);
    });

    it('pattern-governed keys are not unknown under additionalProperties: false', () => {
      const schema: JSONSchema = {
        type: 'object',
        patternProperties: { '^x-': { type: 'number' } },
        additionalProperties: false,
      };
      expect(validateAgainstSchema({ 'x-a': 1 }, schema).ok).toBe(true);
      const r = validateAgainstSchema({ other: 1 }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/unknown property/);
    });

    it('properties and patternProperties both apply to a key (spec)', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        patternProperties: { '^a': { minLength: 1 } },
      };
      expect(validateAgainstSchema({ a: 'str' }, schema).ok).toBe(true);
      const r = validateAgainstSchema({ a: '' }, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.path).toBe('a');
      expect(r.errors[0]!.message).toMatch(/expected string length >= 1, got 0/);
    });

    it('skips invalid regex patterns tolerantly (no crash)', () => {
      const schema: JSONSchema = {
        type: 'object',
        patternProperties: { '(': { type: 'number' } },
      };
      expect(validateAgainstSchema({ anything: 1 }, schema).ok).toBe(true);
    });

    it('non-object values are untouched (type check owns the error)', () => {
      const r = validateAgainstSchema('str', {
        type: 'object',
        patternProperties: { '^x': { type: 'number' } },
        additionalProperties: { type: 'string' },
      });
      expect(r.ok).toBe(false);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(/expected object/);
    });
  });

  describe('array lengths, pattern, and combinators', () => {
    // Round-5 usage survey verdict: minItems/maxItems/uniqueItems, pattern,
    // and allOf/anyOf/oneOf have production declaring schemas on the
    // shared-validator surface (clarify options 2..6, browser secretEnv,
    // telegram chat_id oneOf, mailbox capabilities uniqueItems,
    // migration-planner / semantic-search-indexer allOf+anyOf required
    // conditionals). `const` and `$ref` stayed advisory: the survey found
    // them declared only in the techstack rulebook, which validates with
    // its own `validateRulebook`.

    it('enforces clarify-option array bounds', () => {
      const schema: JSONSchema = {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 6,
      };
      expect(validateAgainstSchema(['only'], schema).ok).toBe(false);
      expect(validateAgainstSchema(['1', '2', '3', '4', '5', '6', '7'], schema).ok).toBe(false);
      expect(validateAgainstSchema(['a', 'b', 'c'], schema).ok).toBe(true);
    });

    it('reports array length messages with counts', () => {
      const r = validateAgainstSchema([1, 2, 3], { type: 'array', maxItems: 2 });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/expected array length <= 2, got 3/);
    });

    it('enforces uniqueItems for primitives and deep-equal objects', () => {
      const schema: JSONSchema = { type: 'array', uniqueItems: true };
      expect(validateAgainstSchema(['a', 'b'], schema).ok).toBe(true);
      expect(validateAgainstSchema(['a', 'a'], schema).ok).toBe(false);
      expect(validateAgainstSchema([{ id: 1 }, { id: 1 }], schema).ok).toBe(false);
      expect(validateAgainstSchema([{ id: 1 }, { id: 2 }], schema).ok).toBe(true);
    });

    it('enforces string pattern and skips invalid regexes tolerantly', () => {
      const schema: JSONSchema = { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' };
      expect(validateAgainstSchema('MY_VAR', schema).ok).toBe(true);
      const bad = validateAgainstSchema('my-var', schema);
      expect(bad.ok).toBe(false);
      expect(bad.errors[0]!.message).toMatch(/expected string matching/);
      expect(validateAgainstSchema('anything', { type: 'string', pattern: '(' }).ok).toBe(true);
    });

    it('enforces oneOf: string|integer accepts both forms, rejects neither/both', () => {
      const schema: JSONSchema = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
      expect(validateAgainstSchema('123456789', schema).ok).toBe(true);
      expect(validateAgainstSchema(123456789, schema).ok).toBe(true);
      expect(validateAgainstSchema(true, schema).ok).toBe(false);
      const both = validateAgainstSchema(10, { oneOf: [{ type: 'number' }, { minimum: 5 }] });
      expect(both.ok).toBe(false);
      expect(both.errors[0]!.message).toMatch(/exactly one/);
    });

    it('enforces anyOf: array|string accepts both forms, rejects neither', () => {
      const schema: JSONSchema = {
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
      };
      expect(validateAgainstSchema('a.txt', schema).ok).toBe(true);
      expect(validateAgainstSchema(['a.txt'], schema).ok).toBe(true);
      expect(validateAgainstSchema(42, schema).ok).toBe(false);
    });

    it('enforces anyOf-required conditionals on untyped subschemas', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { query: { type: 'string' }, q: { type: 'string' } },
        anyOf: [{ required: ['query'] }, { required: ['q'] }],
      };
      expect(validateAgainstSchema({ query: 'x' }, schema).ok).toBe(true);
      expect(validateAgainstSchema({ q: 'y' }, schema).ok).toBe(true);
      const r = validateAgainstSchema({}, schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/anyOf/);
    });

    it('enforces allOf+anyOf required conditionals (migration-planner shape)', () => {
      const schema: JSONSchema = {
        type: 'object',
        allOf: [
          { anyOf: [{ required: ['packageName'] }, { required: ['package'] }] },
          { anyOf: [{ required: ['fromVersion'] }, { required: ['from'] }] },
        ],
      };
      expect(validateAgainstSchema({ packageName: 'x', from: '1.0.0' }, schema).ok).toBe(true);
      expect(validateAgainstSchema({ packageName: 'x' }, schema).ok).toBe(false);
      expect(validateAgainstSchema({ from: '1.0.0' }, schema).ok).toBe(false);
    });

    it('const and $ref stay advisory per the 2026-09-11 survey', () => {
      // Declared only in the techstack rulebook, which validates with its
      // own `validateRulebook` — zero shared-validator surface.
      expect(validateAgainstSchema('2', { const: '1' }).ok).toBe(true);
      expect(validateAgainstSchema({ any: 'thing' }, { $ref: '#/$defs/x' }).ok).toBe(true);
    });
  });

  describe('string pattern safety (ReDoS guard)', () => {
    // Chimera finding: `pattern` executed author-supplied regexes against
    // unbounded model-supplied strings — a catastrophic pattern
    // ((x+x+)+y over a crafted value) stalled validation for 40+ seconds.
    // Two gates with distinct errors: static shape rejection + length cap.
    // The plugin-sdk worker guard is async and cannot be used inside the
    // synchronous walk() contract.

    it('rejects a catastrophic pattern with the distinct unsafe-shape error', () => {
      const r = validateAgainstSchema(`${'x'.repeat(30)}!`, {
        type: 'string',
        pattern: '(x+x+)+y',
      });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/pattern unsafe: quantified group/);
    });

    it('rejects (a|aa)+ and (\\d{2,3})+ shapes (alternation / bounded-body ambiguity)', () => {
      for (const pattern of ['(a|aa)+$', '(\\d{2,3})+$']) {
        const r = validateAgainstSchema('a'.repeat(40), { type: 'string', pattern });
        expect(r.ok).toBe(false);
        expect(r.errors[0]!.message).toMatch(/pattern unsafe/);
      }
    });

    it('caps pattern-checked strings with a distinct error at the boundary', () => {
      const schema: JSONSchema = { type: 'string', pattern: '^x*$' };
      expect(validateAgainstSchema('x'.repeat(10_000), schema).ok).toBe(true);
      const r = validateAgainstSchema('x'.repeat(10_001), schema);
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(
        /pattern not checked: string exceeds safe pattern-check length \(10000\), got 10001/,
      );
    });

    it('safe patterns are unaffected (anchored character-class pattern)', () => {
      const schema: JSONSchema = { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$' };
      expect(validateAgainstSchema('MY_VAR', schema).ok).toBe(true);
      expect(validateAgainstSchema('my-var', schema).ok).toBe(false);
    });

    it('optional-group and non-ambiguous repetition patterns are not false-flagged', () => {
      const schema: JSONSchema = { type: 'string', pattern: '(https?://)?example\\.com' };
      expect(validateAgainstSchema('https://example.com', schema).ok).toBe(true);
      const ab: JSONSchema = { type: 'string', pattern: '^(ab)+$' };
      expect(validateAgainstSchema('ababab', ab).ok).toBe(true);
      expect(validateAgainstSchema('abababx', ab).ok).toBe(false);
    });

    it('conservatively flags disjoint-branch repetition ((red|blue)+)', () => {
      // Documented false-positive trade-off: the shape check cannot prove
      // disjoint branches safe, so it fails closed — the schema author
      // restructures (e.g. (?:red|blue)(?:...)*).
      const r = validateAgainstSchema('redblue', { type: 'string', pattern: '(red|blue)+' });
      expect(r.ok).toBe(false);
      expect(r.errors[0]!.message).toMatch(/pattern unsafe/);
    });

    it('the canonical dash-pinned slug pattern (prompts dataset schema) is not false-flagged', () => {
      // Real regression: every builtin prompt validates against this exact
      // pattern — its iterations are pinned by the mandatory `-`, which
      // [a-z0-9] cannot match, so the shape check must prove it safe.
      const schema: JSONSchema = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' };
      expect(validateAgainstSchema('reduce-hallucination', schema).ok).toBe(true);
      expect(validateAgainstSchema('-leading-dash', schema).ok).toBe(false);
    });

    it('invalid regexes are still skipped tolerantly', () => {
      expect(validateAgainstSchema('anything', { type: 'string', pattern: '(' }).ok).toBe(true);
    });
  });
});

describe('json-schema-validate / coerceAgainstSchema', () => {
  const objSchema: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      force: { type: 'boolean' },
    },
    required: ['path'],
  };

  it('coerces numeric strings to numbers/integers', () => {
    const r = coerceAgainstSchema({ path: 'a.ts', limit: '5', ratio: '0.75' }, objSchema);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ path: 'a.ts', limit: 5, ratio: 0.75 });
  });

  it('coerces "true"/"false" strings to booleans (case-insensitive)', () => {
    const r = coerceAgainstSchema({ path: 'a.ts', force: 'True' }, objSchema);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ path: 'a.ts', force: true });
  });

  it('coerces numbers/booleans to strings when a string is expected', () => {
    const r = coerceAgainstSchema({ path: 42 }, objSchema);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ path: '42' });
  });

  it('revives a double-encoded object string', () => {
    const nested: JSONSchema = {
      type: 'object',
      properties: { opts: { type: 'object', properties: { depth: { type: 'integer' } } } },
    };
    const r = coerceAgainstSchema({ opts: '{"depth":"3"}' }, nested);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ opts: { depth: 3 } });
  });

  it('does NOT coerce lossy cases (non-numeric string, float for integer)', () => {
    expect(coerceAgainstSchema({ path: 'a', limit: '12a' }, objSchema).changed).toBe(false);
    expect(coerceAgainstSchema({ path: 'a', limit: '7.5' }, objSchema).changed).toBe(false);
    expect(coerceAgainstSchema({ path: 'a', force: 'yes' }, objSchema).changed).toBe(false);
  });

  it('returns the original reference when nothing changed', () => {
    const input = { path: 'a.ts', limit: 5 };
    const r = coerceAgainstSchema(input, objSchema);
    expect(r.changed).toBe(false);
    expect(r.value).toBe(input);
  });

  it('coerces items inside arrays', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { lines: { type: 'array', items: { type: 'integer' } } },
    };
    const r = coerceAgainstSchema({ lines: ['1', 2, '3'] }, schema);
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ lines: [1, 2, 3] });
  });

  it('coerced output passes validation', () => {
    const r = coerceAgainstSchema({ path: 'a.ts', limit: '10', force: 'false' }, objSchema);
    expect(validateAgainstSchema(r.value, objSchema).ok).toBe(true);
  });
});
