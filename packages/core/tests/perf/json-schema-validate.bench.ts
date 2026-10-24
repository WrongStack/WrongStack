import type { JSONSchema } from '@wrongstack/contracts/types/tool';
import { describe, test } from 'vitest';
import { validateAgainstSchema } from '../../src/utils/json-schema-validate.js';

/**
 * V0-B: every tool call validates input against the tool's inputSchema. A
 * regression here adds latency to every assistant→tool transition. We
 * cover a typical 5-property schema and a fat 20-property schema with
 * nested objects and arrays.
 */

const smallSchema: JSONSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    encoding: { type: 'string', enum: ['utf8', 'binary'] },
    limit: { type: 'integer', minimum: 1 },
    recursive: { type: 'boolean' },
    pattern: { type: 'string' },
  },
  required: ['path'],
};

const smallValid = { path: '/etc/hosts', encoding: 'utf8', limit: 100, recursive: false };
const smallInvalid = { path: 123, limit: 'lots' };

const largeSchema: JSONSchema = {
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `field_${i}`,
      i % 3 === 0
        ? { type: 'string', enum: ['a', 'b', 'c'] }
        : i % 3 === 1
          ? { type: 'integer', minimum: 0, maximum: 1000 }
          : {
              type: 'object',
              properties: {
                nested: { type: 'array', items: { type: 'string' } },
              },
            },
    ]),
  ),
  required: ['field_0', 'field_1'],
};

const largeValid: Record<string, unknown> = {};
for (let i = 0; i < 20; i++) {
  if (i % 3 === 0) largeValid[`field_${i}`] = 'a';
  else if (i % 3 === 1) largeValid[`field_${i}`] = 42;
  else largeValid[`field_${i}`] = { nested: ['x', 'y', 'z'] };
}

describe('validateAgainstSchema', () => {
  test('5-prop schema, valid input', async ({ bench }) => {
    await bench('5-prop schema, valid input', () => {
      validateAgainstSchema(smallValid, smallSchema);
    }).run();
  });
  test('5-prop schema, invalid input', async ({ bench }) => {
    await bench('5-prop schema, invalid input', () => {
      validateAgainstSchema(smallInvalid, smallSchema);
    }).run();
  });
  test('20-prop schema with nesting, valid input', async ({ bench }) => {
    await bench('20-prop schema with nesting, valid input', () => {
      validateAgainstSchema(largeValid, largeSchema);
    }).run();
  });
});
