import { ToolValidationError } from '@wrongstack/core/types';

export function normalizeMaxConcurrent(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new ToolValidationError({
      message: `maxConcurrent must be a finite integer >= 1, got ${value}`,
      field: 'maxConcurrent',
      context: { received: value },
    });
  }
  return Math.floor(value);
}
