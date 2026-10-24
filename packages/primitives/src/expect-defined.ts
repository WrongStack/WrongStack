/** Assert a value is neither null nor undefined. Throws if it is.
 *  Useful after optional chaining and indexed access when the
 *  control flow guarantees the value exists but TypeScript can't
 *  prove it (e.g. after a check on a related field). */
export function expectDefined<T>(value: T | null | undefined, label?: string): T {
  if (value === null || value === undefined) {
    const err = new Error(
      label ? `Expected ${label} to be defined` : 'Expected value to be defined',
    );
    err.name = 'ExpectDefinedError';
    throw err;
  }
  return value;
}
