const SQLITE_EXPERIMENTAL_WARNING_RE = /sqlite is an experimental feature/i;

function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
  const message =
    typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  const typeOrOptions = rest[0];
  const warningType =
    typeof warning === 'string'
      ? typeof typeOrOptions === 'string'
        ? typeOrOptions
        : typeof typeOrOptions === 'object' &&
            typeOrOptions !== null &&
            'type' in typeOrOptions &&
            typeof typeOrOptions.type === 'string'
          ? typeOrOptions.type
          : ''
      : warning instanceof Error
        ? warning.name
        : '';
  const warningCode =
    typeof warning === 'string'
      ? typeof typeOrOptions === 'object' &&
        typeOrOptions !== null &&
        'code' in typeOrOptions &&
        typeof typeOrOptions.code === 'string'
        ? typeOrOptions.code
        : typeof rest[1] === 'string'
          ? rest[1]
          : ''
      : warning instanceof Error && 'code' in warning && typeof warning.code === 'string'
        ? warning.code
        : '';

  return (
    SQLITE_EXPERIMENTAL_WARNING_RE.test(message) &&
    (warningType === 'ExperimentalWarning' || warningCode === 'ExperimentalWarning')
  );
}

/**
 * Run a synchronous `node:sqlite` load while filtering only Node's built-in
 * SQLite ExperimentalWarning. All other warnings still go through the original
 * process warning path, and the patch is removed before returning.
 */
export function withSqliteExperimentalWarningSuppressed<T>(run: () => T): T {
  const originalEmitWarning = process.emitWarning;
  const forwardWarning = originalEmitWarning.bind(process) as (
    warning: unknown,
    ...rest: unknown[]
  ) => void;

  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    forwardWarning(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    return run();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
