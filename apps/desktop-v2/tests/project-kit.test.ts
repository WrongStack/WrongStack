import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KitParameterForm, KitSchemaDetails, KitValue } from '../src/KitParameterForm';
import {
  type KitSchema,
  kitInitialValue,
  kitInputErrors,
  kitRequest,
  kitValuesEqual,
} from '../src/project-kit-model';

const schema: KitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    names: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 2 } },
    sort: { type: 'boolean', default: false },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 } },
    },
  },
  required: ['names'],
};
describe('Project Kit parameter contract', () => {
  it('initializes required/default fields without inventing optional objects', () => {
    expect(kitInitialValue(schema)).toEqual({ names: [], sort: false });
    expect(kitInitialValue(schema.properties!.options!)).toEqual({ limit: 3 });
    expect(kitInitialValue({ type: 'integer', minimum: 1.5 })).toBe(2);
  });
  it('clones manifest defaults instead of editing them through form state', () => {
    const defaultValue = { tags: ['a'] };
    const next = kitInitialValue({ type: 'object', default: defaultValue }) as typeof defaultValue;
    next.tags.push('b');
    expect(defaultValue.tags).toEqual(['a']);
  });
  it('accepts valid typed parameters, zero values and omitted optional fields', () => {
    expect(kitInputErrors(schema, { names: ['ok'], sort: false })).toEqual([]);
    expect(kitInputErrors({ type: 'number', minimum: 0 }, 0)).toEqual([]);
    expect(kitInputErrors({ type: 'null' }, null)).toEqual([]);
  });
  it('rejects required, extra, nested, nonfinite, integer and range violations', () => {
    expect(kitInputErrors(schema, { names: ['x'], extra: true, options: { limit: 6 } })).toEqual(
      expect.arrayContaining([
        expect.stringContaining('names[1]'),
        expect.stringContaining('extra'),
        expect.stringContaining('limit'),
      ]),
    );
    expect(kitInputErrors(schema, {})).toContain('Input.names: required.');
    for (const value of [NaN, Infinity, 1.5])
      expect(kitInputErrors({ type: 'integer' }, value)).not.toEqual([]);
    expect(kitInputErrors(schema, { names: [] })).toContain('Input.names: at least 1 items.');
  });
  it('compares composite enum values without relying on object key order', () => {
    expect(kitValuesEqual({ a: 1, b: [false] }, { b: [false], a: 1 })).toBe(true);
    expect(
      kitInputErrors(
        {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          enum: [{ a: 1, b: 2 }],
        },
        { b: 2, a: 1 },
      ),
    ).toEqual([]);
    expect(kitValuesEqual([1], { 0: 1 })).toBe(false);
    expect(kitInputErrors({ type: 'string', enum: ['a'] }, 'b')).not.toEqual([]);
  });
  it('pins run and verification requests to the reviewed revision', () => {
    const revision = 'a'.repeat(64);
    const run = kitRequest('fixture.kit', revision, 'run', { names: ['ok'] });
    expect(run).toContain(revision);
    expect(run).toContain('"input"');
    expect(kitRequest('fixture.kit', revision, 'verify', {})).not.toContain('"input"');
    expect(() => kitRequest('../bad', revision, 'run', {})).toThrow();
    expect(() => kitRequest('fixture', 'stale', 'verify', {})).toThrow();
  });
  it('renders human readable contracts, nested values and actual typed inputs', () => {
    const form = renderToStaticMarkup(
      createElement(KitParameterForm, {
        schema,
        value: { names: ['ok'], sort: false },
        onChange() {},
      }),
    );
    expect(form).toContain('type="checkbox"');
    // Fields read their own names, not schema paths; nested ones keep the branch for assistive tech.
    expect(form).toContain('aria-label="Names 1"');
    expect(form).not.toContain('Input.names[1]');
    const details = renderToStaticMarkup(createElement(KitSchemaDetails, { schema }));
    expect(details).toContain('Minimum items 1');
    expect(details).toContain('Maximum 5');
    const values = renderToStaticMarkup(
      createElement(KitValue, { value: { enabled: false, lines: ['a', 'b'] } }),
    );
    expect(values).toContain('<dt>enabled</dt>');
    expect(values).toContain('No');
    expect(values).not.toContain('[object Object]');
  });
});
