/**
 * Validation utilities for IPC messages.
 * Provides safe parsing and error handling for untrusted input.
 */
import type { ZodSchema, ZodError } from 'zod';

/**
 * Result type for validation operations.
 * Success contains the validated data, Failure contains the error.
 */
type ValidationResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Validate data against a Zod schema.
 * Returns a safe result that never throws.
 */
export function validate<T>(schema: ZodSchema<T>, data: unknown): ValidationResult<T> {
  try {
    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: formatZodError(result.error) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Validate data and throw on failure.
 * Use this when you want to reject invalid input.
 */
export function validateOrThrow<T>(schema: ZodSchema<T>, data: unknown, context?: string): T {
  const result = validate(schema, data);
  if (!result.success) {
    const prefix = context ? `[${context}] ` : '';
    throw new Error(`${prefix}Validation failed: ${result.error}`);
  }
  return result.data;
}

/**
 * Validate with a fallback value.
 * Returns the validated data or a default on failure.
 */
export function validateOrDefault<T>(schema: ZodSchema<T>, data: unknown, defaultValue: T): T {
  const result = validate(schema, data);
  return result.success ? result.data : defaultValue;
}

/**
 * Validate optional input.
 * Returns undefined for undefined/null input, validated data otherwise.
 */
export function validateOptional<T>(schema: ZodSchema<T>, data: unknown): T | undefined {
  if (data === undefined || data === null) return undefined;
  const result = validate(schema, data);
  return result.success ? result.data : undefined;
}

/**
 * Format Zod error into a human-readable string.
 */
function formatZodError(error: ZodError): string {
  return error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

/**
 * Create a logger for validation errors.
 * Helps track malformed messages for debugging.
 */
export function createValidationLogger(prefix: string) {
  const loggedErrors = new Set<string>();
  const maxErrors = 100;

  return {
    log(error: string): void {
      if (loggedErrors.size >= maxErrors) return;
      const key = `${prefix}:${error}`;
      if (!loggedErrors.has(key)) {
        loggedErrors.add(key);
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'desktop.validation_error',
            prefix,
            message: error,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    },
    reset(): void {
      loggedErrors.clear();
    },
  };
}
