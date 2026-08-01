export type BuildOutputCleanupResult = 'removed' | 'retained-empty';

export interface BuildOutputCleanupDependencies {
  removeSync?: (
    outputPath: string,
    options: {
      recursive: true;
      force: true;
      maxRetries: number;
      retryDelay: number;
    },
  ) => void;
  listSync?: (outputPath: string) => readonly unknown[];
}

export function cleanBuildOutput(
  outputPath: string,
  dependencies?: BuildOutputCleanupDependencies,
): BuildOutputCleanupResult;
