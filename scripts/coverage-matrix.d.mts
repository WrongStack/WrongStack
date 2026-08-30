export interface CoverageSummaryLocation {
  label: string;
  summaryPath: string;
}

export interface ParsedCoverageSummary extends CoverageSummaryLocation {
  mtimeMs: number;
  json: unknown;
  error?: string;
}

export interface CoverageMatrixRow {
  label: string;
  lines: string;
  statements: string;
  functions: string;
  branches: string;
  uncoveredStatements: number | null;
  measuredOn: string;
  ageDays: number;
  error?: string;
}

export interface WorstCoverageFile {
  file: string;
  uncoveredStatements: number;
  linesPct: number;
}

export interface RunCoverageMatrixDeps {
  repoRoot?: string;
  log?: (message: string) => void;
  nowMs?: number;
}

export declare function isDirectRun(metaUrl?: string, argvEntry?: string): boolean;
export declare function discoverSummaries(repoRoot: string): CoverageSummaryLocation[];
export declare function summarize(location: CoverageSummaryLocation): ParsedCoverageSummary | null;
export declare function buildMatrix(
  summaries: Array<ParsedCoverageSummary | null>,
  nowMs?: number,
): CoverageMatrixRow[];
export declare function worstFiles(summaryJson: unknown, limit?: number): WorstCoverageFile[];
export declare function renderMarkdown(input: {
  rows: CoverageMatrixRow[];
  worst: WorstCoverageFile[];
  generatedAt: string;
}): string;
export declare function run(argv?: string[], deps?: RunCoverageMatrixDeps): number;
