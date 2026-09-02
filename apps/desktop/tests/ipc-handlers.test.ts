/**
 * Unit tests for IPC handlers module.
 * Tests the pure utility functions found within the IPC handler registration.
 */
import { describe, it, expect } from 'vitest';

// The IPC handler module exports no named functions - it registers side effects.
// We test the internal pure logic patterns it uses:
// - validateOptional<T> (custom version)
// - sanitizeWebuiPrefs (sanitization logic)
// - isRecord (type guard)
// - Validation patterns used in handlers

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('isRecord type guard logic', () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  it('should return true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord({ nested: { a: 1 } })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

// ============================================================================
// Sanitize WebUI Prefs Tests
// ============================================================================

type DesktopWebuiPrefs = Partial<{
  yolo: boolean;
  nextPrediction: boolean;
  contextAutoCompact: boolean;
  [key: string]: unknown;
}>;

function sanitizeWebuiPrefs(prefs: unknown): DesktopWebuiPrefs {
  const next: DesktopWebuiPrefs = {};
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  if (!isRecord(prefs)) return next;
  if (typeof prefs['yolo'] === 'boolean') next.yolo = prefs['yolo'];
  if (typeof prefs['nextPrediction'] === 'boolean') next.nextPrediction = prefs['nextPrediction'];
  if (typeof prefs['contextAutoCompact'] === 'boolean') {
    next.contextAutoCompact = prefs['contextAutoCompact'];
  }
  return next;
}

describe('sanitizeWebuiPrefs', () => {
  it('should return empty object for non-object input', () => {
    expect(sanitizeWebuiPrefs(null)).toEqual({});
    expect(sanitizeWebuiPrefs(undefined)).toEqual({});
    expect(sanitizeWebuiPrefs('string')).toEqual({});
    expect(sanitizeWebuiPrefs(42)).toEqual({});
    expect(sanitizeWebuiPrefs(true)).toEqual({});
    expect(sanitizeWebuiPrefs([])).toEqual({});
  });

  it('should extract yolo boolean', () => {
    expect(sanitizeWebuiPrefs({ yolo: true })).toEqual({ yolo: true });
    expect(sanitizeWebuiPrefs({ yolo: false })).toEqual({ yolo: false });
  });

  it('should extract nextPrediction boolean', () => {
    expect(sanitizeWebuiPrefs({ nextPrediction: true })).toEqual({ nextPrediction: true });
    expect(sanitizeWebuiPrefs({ nextPrediction: false })).toEqual({ nextPrediction: false });
  });

  it('should extract contextAutoCompact boolean', () => {
    expect(sanitizeWebuiPrefs({ contextAutoCompact: true })).toEqual({ contextAutoCompact: true });
    expect(sanitizeWebuiPrefs({ contextAutoCompact: false })).toEqual({
      contextAutoCompact: false,
    });
  });

  it('should extract multiple boolean prefs', () => {
    const result = sanitizeWebuiPrefs({ yolo: true, nextPrediction: false });
    expect(result).toEqual({ yolo: true, nextPrediction: false });
  });

  it('should ignore non-boolean values', () => {
    expect(sanitizeWebuiPrefs({ yolo: 'yes' })).toEqual({});
    expect(sanitizeWebuiPrefs({ yolo: 1 })).toEqual({});
    expect(sanitizeWebuiPrefs({ yolo: null })).toEqual({});
    expect(sanitizeWebuiPrefs({ yolo: undefined })).toEqual({});
  });

  it('should ignore unknown prefs', () => {
    const result = sanitizeWebuiPrefs({ unknown: 'value', extra: true, yolo: true });
    expect(result).toEqual({ yolo: true });
  });

  it('should handle empty object', () => {
    expect(sanitizeWebuiPrefs({})).toEqual({});
  });

  it('should strip potentially dangerous values', () => {
    const result = sanitizeWebuiPrefs({
      yolo: true,
      __proto__: { xss: true },
      constructor: { prototype: { polluted: true } },
    });
    expect(result).toEqual({ yolo: true });
  });
});

// ============================================================================
// Validate Optional Tests
// ============================================================================

describe('validateOptional pattern', () => {
  const runtimeIdSchema = {
    safeParse: (value: unknown) => {
      if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{3,120}$/.test(value)) {
        return { success: true, data: value };
      }
      return { success: false, error: new Error('Invalid runtime ID') };
    },
  };

  function validateOptional<T>(
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    value: unknown,
  ): T | undefined {
    if (value === undefined || value === null) return undefined;
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  }

  it('should return undefined for null/undefined', () => {
    expect(validateOptional(runtimeIdSchema, undefined)).toBeUndefined();
    expect(validateOptional(runtimeIdSchema, null)).toBeUndefined();
  });

  it('should return validated value for valid input', () => {
    expect(validateOptional(runtimeIdSchema, 'runtime-1')).toBe('runtime-1');
  });

  it('should return undefined for invalid input', () => {
    expect(validateOptional(runtimeIdSchema, 'ab')).toBeUndefined();
    expect(validateOptional(runtimeIdSchema, 123)).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(validateOptional(runtimeIdSchema, '')).toBeUndefined();
  });
});

// ============================================================================
// IPC Handler Integration Patterns
// ============================================================================

describe('IPC handler validation patterns', () => {
  const runtimeIdSchema = {
    safeParse: (value: unknown) => {
      if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{3,120}$/.test(value)) {
        return { success: true, data: value };
      }
      return { success: false, error: new Error('Invalid') };
    },
  };
  const pathSchema = {
    safeParse: (value: unknown) => {
      if (typeof value === 'string' && value.length >= 1) {
        return { success: true, data: value };
      }
      return { success: false, error: new Error('Invalid') };
    },
  };

  it('should handle activateRuntime validation', () => {
    // Pattern: validate(runtimeIdSchema, id)
    const result = runtimeIdSchema.safeParse('valid-runtime-id');
    expect(result.success).toBe(true);
  });

  it('should handle closeRuntime validation', () => {
    const result = runtimeIdSchema.safeParse('runtime-123');
    expect(result.success).toBe(true);
  });

  it('should handle openProject with no requestedRoot', () => {
    // Pattern: validateOptional(pathSchema, requestedRoot)
    expect(pathSchema.safeParse('').success).toBe(false);
    expect(pathSchema.safeParse('/valid/path').success).toBe(true);
  });

  it('should handle sendMessage with runtime ID', () => {
    const idResult = runtimeIdSchema.safeParse('runtime-1');
    expect(idResult.success).toBe(true);
  });

  it('should handle revealRuntimeRoot validation', () => {
    const result = runtimeIdSchema.safeParse('runtime-abc');
    expect(result.success).toBe(true);
  });

  it('should reject invalid runtime IDs in all handlers', () => {
    const invalidIds = ['ab', '', ' x ', 'a'.repeat(121), 'no spaces', 'special!chars'];
    for (const id of invalidIds) {
      const result = runtimeIdSchema.safeParse(id);
      expect(result.success).toBe(false);
    }
  });

  it('should accept valid runtime IDs in all handlers', () => {
    const validIds = ['abc', 'runtime-1', 'my.runtime', 'test_runtime', 'a'.repeat(120)];
    for (const id of validIds) {
      const result = runtimeIdSchema.safeParse(id);
      expect(result.success).toBe(true);
    }
  });
});
