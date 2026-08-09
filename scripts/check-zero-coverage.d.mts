export interface CoverageZeroBaseline {
  schemaVersion?: number | undefined;
  files?: readonly string[] | undefined;
}

export interface ZeroCoverageComparison {
  actual: string[];
  unexpected: string[];
  resolved: string[];
}

export interface CheckZeroCoverageOptions {
  summaryPath?: string | undefined;
  baselinePath?: string | undefined;
  repoRoot?: string | undefined;
  readJson?: ((file: string) => unknown) | undefined;
  log?: ((message: string) => void) | undefined;
  error?: ((message: string) => void) | undefined;
}

export interface RunZeroCoverageOptions {
  check?: (() => number) | undefined;
  error?: ((message: string) => void) | undefined;
}

export const DEFAULT_SUMMARY_PATH: string;
export const DEFAULT_BASELINE_PATH: string;
export function normalizeCoveragePath(file: string, root?: string): string;
export function zeroStatementFiles(summary: Record<string, unknown>, root?: string): string[];
export function compareZeroCoverage(
  summary: Record<string, unknown>,
  baseline: CoverageZeroBaseline,
  root?: string,
): ZeroCoverageComparison;
export function checkZeroCoverage(options?: CheckZeroCoverageOptions): number;
export function isDirectRun(metaUrl?: string, argvEntry?: string): boolean;
export function runDirect(options?: RunZeroCoverageOptions): number;
