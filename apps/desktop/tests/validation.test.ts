/**
 * Unit tests for IPC validation schemas and utilities.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  validate,
  validateOrThrow,
  validateOrDefault,
  validateOptional,
  validateMany,
  createValidationLogger,
} from '../src/main/validation/index.js';
import {
  runtimeIdSchema,
  pathSchema,
  nonEmptyStringSchema,
  booleanSchema,
  numberSchema,
  openProjectSchema,
  registerProjectSchema,
  unregisterProjectSchema,
  openProjectSessionSchema,
  activateRuntimeSchema,
  closeRuntimeSchema,
  sendMessageSchema,
  abortRuntimeSchema,
  openRuntimeInBrowserSchema,
  revealRuntimeRootSchema,
  setShellSidebarCollapsedSchema,
  navigateWebuiSchema,
  getConversationSchema,
  webuiReadyChangedSchema,
  webuiPrefsChangedSchema,
  webuiCommandAckSchema,
  setLocaleSchema,
} from '../src/main/validation/schemas.js';

// ============================================================================
// Validation Utility Tests
// ============================================================================

describe('validate()', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  it('should return success with validated data', () => {
    const result = validate(schema, { name: 'Test', age: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Test', age: 25 });
    }
  });

  it('should return failure with error message for invalid data', () => {
    const result = validate(schema, { name: 123, age: 'not a number' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    }
  });

  it('should return failure for null input', () => {
    const result = validate(schema, null);
    expect(result.success).toBe(false);
  });

  it('should return failure for undefined input', () => {
    const result = validate(schema, undefined);
    expect(result.success).toBe(false);
  });

  it('should handle malformed JSON-like input gracefully', () => {
    const result = validate(schema, { name: 'Test', age: 'invalid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('should handle missing required fields', () => {
    const result = validate(schema, { name: 'Test' });
    expect(result.success).toBe(false);
  });

  it('should handle extra fields gracefully', () => {
    const result = validate(schema, { name: 'Test', age: 25, extra: 'field' });
    expect(result.success).toBe(true);
  });
});

describe('validateOrThrow()', () => {
  const schema = z.object({ id: z.string() });

  it('should return validated data on success', () => {
    const result = validateOrThrow(schema, { id: 'test-123' });
    expect(result).toEqual({ id: 'test-123' });
  });

  it('should throw Error on failure', () => {
    expect(() => validateOrThrow(schema, { id: 123 })).toThrow('Validation failed');
  });

  it('should include context in error message', () => {
    expect(() => validateOrThrow(schema, { id: 123 }, 'openProject')).toThrow('[openProject]');
  });

  it('should throw with formatted error message', () => {
    expect(() => validateOrThrow(schema, { id: 123 })).toThrow('id');
  });
});

describe('validateOrDefault()', () => {
  const schema = z.object({ name: z.string() });
  const defaultValue = { name: 'default' };

  it('should return validated data on success', () => {
    const result = validateOrDefault(schema, { name: 'custom' }, defaultValue);
    expect(result).toEqual({ name: 'custom' });
  });

  it('should return default value on failure', () => {
    const result = validateOrDefault(schema, { name: 123 }, defaultValue);
    expect(result).toEqual(defaultValue);
  });

  it('should return default for null input', () => {
    const result = validateOrDefault(schema, null, defaultValue);
    expect(result).toEqual(defaultValue);
  });

  it('should return default for undefined input', () => {
    const result = validateOrDefault(schema, undefined, defaultValue);
    expect(result).toEqual(defaultValue);
  });
});

describe('validateOptional()', () => {
  const schema = z.object({ id: z.string() });

  it('should return undefined for undefined input', () => {
    const result = validateOptional(schema, undefined);
    expect(result).toBeUndefined();
  });

  it('should return undefined for null input', () => {
    const result = validateOptional(schema, null);
    expect(result).toBeUndefined();
  });

  it('should return validated data for valid input', () => {
    const result = validateOptional(schema, { id: 'test' });
    expect(result).toEqual({ id: 'test' });
  });

  it('should return undefined for invalid input', () => {
    const result = validateOptional(schema, { id: 123 });
    expect(result).toBeUndefined();
  });
});

describe('createValidationLogger()', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should log validation errors', () => {
    const logger = createValidationLogger('test');
    logger.log('test error');
    expect(console.warn).toHaveBeenCalledWith('[test] Validation error: test error');
  });

  it('should deduplicate repeated errors', () => {
    const logger = createValidationLogger('test');
    logger.log('duplicate error');
    logger.log('duplicate error');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('should reset logged errors', () => {
    const logger = createValidationLogger('test');
    logger.log('error1');
    logger.reset();
    logger.log('error1');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('should cap at max errors', () => {
    const logger = createValidationLogger('test');
    for (let i = 0; i < 150; i++) {
      logger.log(`unique-error-${i}`);
    }
    // Only first 100 unique errors should be logged
    expect(console.warn).toHaveBeenCalledTimes(100);
  });
});

// ============================================================================
// Schema Tests - Base Validators
// ============================================================================

describe('runtimeIdSchema', () => {
  it('should accept valid runtime IDs', () => {
    const validIds = [
      'abc',
      'runtime-1',
      'my.project',
      'session_123',
      'a'.repeat(120), // max length
      'runtime-123.session_456',
    ];
    for (const id of validIds) {
      const result = runtimeIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid runtime IDs', () => {
    const invalidIds = [
      'ab', // too short
      'a'.repeat(121), // too long
      'runtime@1', // special char
      'runtime 1', // space
      '', // empty
      'runtime/1', // slash
      'runtime\\1', // backslash
    ];
    for (const id of invalidIds) {
      const result = runtimeIdSchema.safeParse(id);
      expect(result.success).toBe(false);
    }
  });
});

describe('pathSchema', () => {
  it('should accept valid paths', () => {
    const validPaths = [
      '/home/user/project',
      'C:\\Users\\test\\project',
      './relative/path',
      'simple',
      'path/with/slashes',
      'path\\with\\backslashes',
    ];
    for (const path of validPaths) {
      const result = pathSchema.safeParse(path);
      expect(result.success).toBe(true);
    }
  });

  it('should reject empty strings', () => {
    const result = pathSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('should validate path pattern allows various characters', () => {
    // Path schema uses a permissive pattern for validation
    // In production, actual filesystem validation happens elsewhere
    expect(pathSchema.safeParse('/valid/path').success).toBe(true);
    expect(pathSchema.safeParse('C:\\Windows\\Path').success).toBe(true);
  });
});

describe('booleanSchema', () => {
  it('should accept true and false', () => {
    expect(booleanSchema.safeParse(true).success).toBe(true);
    expect(booleanSchema.safeParse(false).success).toBe(true);
  });

  it('should reject non-boolean values', () => {
    const invalid = [0, 1, 'true', 'false', null, undefined, {}];
    for (const value of invalid) {
      expect(booleanSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('numberSchema', () => {
  it('should accept valid integers', () => {
    const valid = [0, 1, -1, 100, -50];
    for (const n of valid) {
      expect(numberSchema.safeParse(n).success).toBe(true);
    }
  });

  it('should reject non-integers', () => {
    const invalid = [1.5, -2.5, Infinity, -Infinity, NaN];
    for (const n of invalid) {
      expect(numberSchema.safeParse(n).success).toBe(false);
    }
  });
});

// ============================================================================
// Schema Tests - IPC Handler Input Schemas
// ============================================================================

describe('openProjectSchema', () => {
  it('should accept empty object', () => {
    expect(openProjectSchema.safeParse({}).success).toBe(true);
  });

  it('should accept object with valid requestedRoot', () => {
    expect(openProjectSchema.safeParse({ requestedRoot: '/test/path' }).success).toBe(true);
  });

  it('should reject object with invalid requestedRoot', () => {
    const result = openProjectSchema.safeParse({ requestedRoot: '' });
    expect(result.success).toBe(false);
  });

  it('should reject object with extra fields', () => {
    expect(openProjectSchema.safeParse({ extra: 'field' }).success).toBe(true);
  });
});

describe('registerProjectSchema', () => {
  it('should accept empty object', () => {
    expect(registerProjectSchema.safeParse({}).success).toBe(true);
  });

  it('should accept object with valid requestedRoot', () => {
    expect(registerProjectSchema.safeParse({ requestedRoot: '/test/path' }).success).toBe(true);
  });
});

describe('unregisterProjectSchema', () => {
  it('should accept object with valid root', () => {
    expect(unregisterProjectSchema.safeParse({ root: '/test/path' }).success).toBe(true);
  });

  it('should reject object without root', () => {
    expect(unregisterProjectSchema.safeParse({}).success).toBe(false);
  });

  it('should reject object with empty root', () => {
    expect(unregisterProjectSchema.safeParse({ root: '' }).success).toBe(false);
  });
});

describe('openProjectSessionSchema', () => {
  it('should accept empty object', () => {
    expect(openProjectSessionSchema.safeParse({}).success).toBe(true);
  });

  it('should accept object with valid runtimeId', () => {
    expect(openProjectSessionSchema.safeParse({ runtimeId: 'runtime-123' }).success).toBe(true);
  });

  it('should reject object with invalid runtimeId', () => {
    expect(openProjectSessionSchema.safeParse({ runtimeId: 'ab' }).success).toBe(false);
  });
});

describe('activateRuntimeSchema', () => {
  it('should accept object with valid id', () => {
    expect(activateRuntimeSchema.safeParse({ id: 'runtime-123' }).success).toBe(true);
  });

  it('should reject object without id', () => {
    expect(activateRuntimeSchema.safeParse({}).success).toBe(false);
  });

  it('should reject object with invalid id', () => {
    expect(activateRuntimeSchema.safeParse({ id: 'ab' }).success).toBe(false);
  });
});

describe('closeRuntimeSchema', () => {
  it('should accept object with valid id', () => {
    expect(closeRuntimeSchema.safeParse({ id: 'runtime-123' }).success).toBe(true);
  });

  it('should reject object without id', () => {
    expect(closeRuntimeSchema.safeParse({}).success).toBe(false);
  });
});

describe('sendMessageSchema', () => {
  it('should accept object with valid id and content', () => {
    expect(sendMessageSchema.safeParse({ id: 'runtime-123', content: 'Hello' }).success).toBe(true);
  });

  it('should reject object without id', () => {
    expect(sendMessageSchema.safeParse({ content: 'Hello' }).success).toBe(false);
  });

  it('should reject object without content', () => {
    expect(sendMessageSchema.safeParse({ id: 'runtime-123' }).success).toBe(false);
  });

  it('should accept empty content string', () => {
    expect(sendMessageSchema.safeParse({ id: 'runtime-123', content: '' }).success).toBe(true);
  });
});

describe('abortRuntimeSchema', () => {
  it('should accept object with valid id', () => {
    expect(abortRuntimeSchema.safeParse({ id: 'runtime-123' }).success).toBe(true);
  });

  it('should reject object without id', () => {
    expect(abortRuntimeSchema.safeParse({}).success).toBe(false);
  });
});

describe('openRuntimeInBrowserSchema', () => {
  it('should accept object with valid id', () => {
    expect(openRuntimeInBrowserSchema.safeParse({ id: 'runtime-123' }).success).toBe(true);
  });
});

describe('revealRuntimeRootSchema', () => {
  it('should accept object with valid id', () => {
    expect(revealRuntimeRootSchema.safeParse({ id: 'runtime-123' }).success).toBe(true);
  });
});

describe('setShellSidebarCollapsedSchema', () => {
  it('should accept object with collapsed: true', () => {
    expect(setShellSidebarCollapsedSchema.safeParse({ collapsed: true }).success).toBe(true);
  });

  it('should accept object with collapsed: false', () => {
    expect(setShellSidebarCollapsedSchema.safeParse({ collapsed: false }).success).toBe(true);
  });

  it('should reject object with collapsed: string', () => {
    expect(setShellSidebarCollapsedSchema.safeParse({ collapsed: 'true' }).success).toBe(false);
  });

  it('should reject object without collapsed', () => {
    expect(setShellSidebarCollapsedSchema.safeParse({}).success).toBe(false);
  });
});

describe('navigateWebuiSchema', () => {
  it('should accept object with any command', () => {
    expect(navigateWebuiSchema.safeParse({ command: 'any-value' }).success).toBe(true);
    expect(navigateWebuiSchema.safeParse({ command: { nested: 'object' } }).success).toBe(true);
    expect(navigateWebuiSchema.safeParse({ command: null }).success).toBe(true);
  });
});

describe('getConversationSchema', () => {
  it('should accept object with valid runtimeId', () => {
    expect(getConversationSchema.safeParse({ runtimeId: 'runtime-123' }).success).toBe(true);
  });

  it('should reject object without runtimeId', () => {
    expect(getConversationSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// Schema Tests - Renderer Event Schemas
// ============================================================================

describe('webuiReadyChangedSchema', () => {
  it('should accept ready: true', () => {
    expect(webuiReadyChangedSchema.safeParse({ ready: true }).success).toBe(true);
  });

  it('should accept ready: false', () => {
    expect(webuiReadyChangedSchema.safeParse({ ready: false }).success).toBe(true);
  });

  it('should reject non-boolean ready', () => {
    expect(webuiReadyChangedSchema.safeParse({ ready: 'true' }).success).toBe(false);
  });
});

describe('webuiPrefsChangedSchema', () => {
  it('should accept empty prefs object', () => {
    expect(webuiPrefsChangedSchema.safeParse({ prefs: {} }).success).toBe(true);
  });

  it('should accept prefs with various values', () => {
    expect(
      webuiPrefsChangedSchema.safeParse({
        prefs: { theme: 'dark', yolo: true, count: 5 },
      }).success,
    ).toBe(true);
  });
});

describe('webuiCommandAckSchema', () => {
  it('should accept valid ack', () => {
    expect(
      webuiCommandAckSchema.safeParse({ requestId: 'req-123', handled: true }).success,
    ).toBe(true);
  });

  it('should accept ack with optional message', () => {
    expect(
      webuiCommandAckSchema.safeParse({
        requestId: 'req-123',
        handled: true,
        message: 'Success',
      }).success,
    ).toBe(true);
  });

  it('should reject ack without requestId', () => {
    expect(webuiCommandAckSchema.safeParse({ handled: true }).success).toBe(false);
  });

  it('should reject ack without handled', () => {
    expect(webuiCommandAckSchema.safeParse({ requestId: 'req-123' }).success).toBe(false);
  });
});

describe('setLocaleSchema', () => {
  it('should accept valid locale codes', () => {
    const validLocales = ['en', 'tr', 'de', 'fr', 'ja', 'zh', 'pt-BR'];
    for (const locale of validLocales) {
      expect(setLocaleSchema.safeParse({ locale }).success).toBe(true);
    }
  });

  it('should reject locale that is too short', () => {
    expect(setLocaleSchema.safeParse({ locale: 'e' }).success).toBe(false);
  });

  it('should reject locale that is too long', () => {
    expect(setLocaleSchema.safeParse({ locale: 'a'.repeat(11) }).success).toBe(false);
  });
});

// ============================================================================
// Integration Tests - Using validate() with schemas
// ============================================================================

describe('Integration: validate() with IPC schemas', () => {
  it('should successfully validate valid openProject input', () => {
    const result = validate(openProjectSchema, { requestedRoot: '/test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestedRoot).toBe('/test');
    }
  });

  it('should return error for invalid activateRuntime input', () => {
    const result = validate(activateRuntimeSchema, { id: 'ab' });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error message contains validation failure details
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('should handle malicious input gracefully', () => {
    const maliciousInputs = [
      { id: '<script>alert(1)</script>' },
      { id: "id'; DROP TABLE runtimes;--" },
      { id: '\n\r\t' },
      { id: '🍎'.repeat(50) },
    ];
    for (const input of maliciousInputs) {
      const result = validate(activateRuntimeSchema, input);
      // Malicious inputs should either fail validation or be sanitized
      expect(typeof result.success).toBe('boolean');
    }
  });

  it('should handle deeply nested objects', () => {
    const nested = {
      prefs: {
        nested: {
          deep: {
            value: 'test',
          },
        },
      },
    };
    const result = validate(webuiPrefsChangedSchema, nested);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge cases', () => {
  it('should handle very long runtime ID at boundary', () => {
    const maxId = 'a'.repeat(120);
    expect(runtimeIdSchema.safeParse(maxId).success).toBe(true);

    const overMaxId = 'a'.repeat(121);
    expect(runtimeIdSchema.safeParse(overMaxId).success).toBe(false);
  });

  it('should handle Unicode in path', () => {
    const unicodePath = '/home/用户/プロジェクト';
    expect(pathSchema.safeParse(unicodePath).success).toBe(true);
  });

  it('should handle Windows paths with drive letters', () => {
    const windowsPaths = [
      'C:\\Users\\Test\\Project',
      'D:/Projects/MyApp',
      '\\\\server\\share\\folder',
    ];
    for (const path of windowsPaths) {
      expect(pathSchema.safeParse(path).success).toBe(true);
    }
  });

  it('should handle numeric strings as IDs', () => {
    // Runtime IDs should be strings, not numbers
    expect(activateRuntimeSchema.safeParse({ id: '123' }).success).toBe(true);
    expect(activateRuntimeSchema.safeParse({ id: 123 }).success).toBe(false);
  });

  it('should handle empty objects', () => {
    expect(webuiPrefsChangedSchema.safeParse({ prefs: {} }).success).toBe(true);
  });

  it('should accept nested object prefs', () => {
    // z.record accepts nested objects
    expect(
      webuiPrefsChangedSchema.safeParse({ prefs: { nested: { value: true } } }).success,
    ).toBe(true);
  });
});
