/**
 * Error types for the vector memory package.
 *
 * Kept in their own module so callers can `instanceof`-check without
 * pulling the full store implementation.
 */

export class VectorMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorMemoryError';
  }
}

/**
 * Raised when the configured embedding provider is unavailable — typically
 * because `@huggingface/transformers` was not installed or the model
 * failed to load. The original cause (if any) is attached for diagnostics.
 */
export class VectorMemoryProviderUnavailableError extends VectorMemoryError {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VectorMemoryProviderUnavailableError';
    this.cause = cause;
  }
}
