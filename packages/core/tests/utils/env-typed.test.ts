import { describe, expect, it } from 'vitest';
import {
  envBool,
  envBoolOptional,
  envEnum,
  envFloat,
  envInt,
  envString,
} from '../../src/utils/env-typed.js';

describe('envBool', () => {
  it('returns false for unset env var', () => {
    expect(envBool('TEST_UNSET_VAR_XYZ', {})).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(envBool('TEST_VAR', { TEST_VAR: '' })).toBe(false);
  });

  it('returns false for falsy values', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No', 'OFF']) {
      expect(envBool('TEST_VAR', { TEST_VAR: v })).toBe(false);
    }
  });

  it('returns true for truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything', 'TRUE', 'On']) {
      expect(envBool('TEST_VAR', { TEST_VAR: v })).toBe(true);
    }
  });
});

describe('envBoolOptional', () => {
  it('returns undefined for unset', () => {
    expect(envBoolOptional('TEST_UNSET', {})).toBeUndefined();
  });

  it('returns false for explicit falsy', () => {
    expect(envBoolOptional('TEST_VAR', { TEST_VAR: '0' })).toBe(false);
  });

  it('returns true for truthy', () => {
    expect(envBoolOptional('TEST_VAR', { TEST_VAR: 'yes' })).toBe(true);
  });
});

describe('envInt', () => {
  it('returns default for unset', () => {
    expect(envInt('TEST_UNSET', { default: 42 }, {})).toBe(42);
  });

  it('parses valid integer', () => {
    expect(envInt('TEST_VAR', { default: 0 }, { TEST_VAR: '123' })).toBe(123);
  });

  it('returns default for NaN', () => {
    expect(envInt('TEST_VAR', { default: 42 }, { TEST_VAR: 'abc' })).toBe(42);
  });

  it('returns default when below min', () => {
    expect(envInt('TEST_VAR', { default: 100, min: 50 }, { TEST_VAR: '10' })).toBe(100);
  });

  it('returns default when above max', () => {
    expect(envInt('TEST_VAR', { default: 100, max: 500 }, { TEST_VAR: '999' })).toBe(100);
  });

  it('returns value within range', () => {
    expect(envInt('TEST_VAR', { default: 0, min: 1, max: 10 }, { TEST_VAR: '5' })).toBe(5);
  });
});

describe('envFloat', () => {
  it('parses float values', () => {
    expect(envFloat('TEST_VAR', { default: 0 }, { TEST_VAR: '3.14' })).toBe(3.14);
  });

  it('returns default for invalid', () => {
    expect(envFloat('TEST_VAR', { default: 1.5 }, { TEST_VAR: 'not-a-number' })).toBe(1.5);
  });
});

describe('envString', () => {
  it('returns undefined for unset', () => {
    expect(envString('TEST_UNSET', {})).toBeUndefined();
  });

  it('returns trimmed value', () => {
    expect(envString('TEST_VAR', { TEST_VAR: '  hello  ' })).toBe('hello');
  });

  it('returns undefined for empty after trim', () => {
    expect(envString('TEST_VAR', { TEST_VAR: '   ' })).toBeUndefined();
  });
});

describe('envEnum', () => {
  const allowed = ['debug', 'info', 'warn', 'error'] as const;

  it('returns value when in allow-list', () => {
    expect(envEnum('TEST_VAR', allowed, { default: 'info' }, { TEST_VAR: 'debug' })).toBe('debug');
  });

  it('returns default for invalid value', () => {
    expect(envEnum('TEST_VAR', allowed, { default: 'info' }, { TEST_VAR: 'trace' })).toBe('info');
  });

  it('returns default for unset', () => {
    expect(envEnum('TEST_UNSET', allowed, { default: 'info' }, {})).toBe('info');
  });
});
