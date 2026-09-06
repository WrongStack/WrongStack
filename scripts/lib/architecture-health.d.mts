export interface ModuleSpecifier {
  specifier: string;
  typeOnly: boolean;
  syntax: string;
}

export function collectModuleSpecifiers(sourceText: string, fileName: string): ModuleSpecifier[];
export function stronglyConnectedComponents(
  nodes: Iterable<string>,
  adjacency: Map<string, Set<string>>,
): string[][];
export function globToRegExp(pattern: string): RegExp;
export function parseTsConfigFiles(
  repoRoot: string,
  packageDir: string,
  packageTestFiles: string[],
): Promise<Array<{ path: string; error: string | null; testFiles: string[] }>>;
export function findNonCommandSlashImports<T extends { from: string; to: string }>(edges: T[]): T[];
export function validateHotspotBaseline(
  sourceMetrics: Array<{ file: string; lines: number; relativeImports: number }>,
  baseline: {
    thresholdLines: number;
    files: Record<string, { lines: number; relativeImports: number }>;
  },
): {
  errors: string[];
  candidates: Array<{ file: string; lines: number; relativeImports: number }>;
};

export function collectRuntimeExports(sourceText: string): Set<string>;
export function collectIdentifiers(sourceText: string): Set<string>;
export function findTestOnlyExports(input: {
  exportsByFile: Map<string, Set<string>>;
  sourceIdentifiers: Map<string, { files: number; firstFile: string }>;
  testIdentifiers: Set<string>;
}): Array<{ file: string; name: string }>;
export function validateTestOnlyExportBaseline(
  current: Array<{ file: string; name: string }>,
  baseline: { files?: Record<string, string[]> },
): { errors: string[] };

export interface ArchitectureHealthReport {
  generatedAt: string;
  errors: string[];
  scope: { workspaceRoots: string[]; excludedPaths: string[] };
  summary: { sourceFiles: number; [key: string]: number };
  packages: unknown[];
  testOwnership: {
    runtimeAssignments: unknown[];
    [key: string]: unknown;
  };
  cycles: {
    runtime: unknown[];
    type: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function buildArchitectureHealth(options: {
  repoRoot: string;
  registry: unknown;
  exceptions: unknown;
  hotspots: unknown;
  now?: Date;
}): Promise<ArchitectureHealthReport>;
export function renderArchitectureHealthMarkdown(report: ArchitectureHealthReport): string;
export interface ReportFreshnessResult {
  status: 'fresh' | 'stale' | 'skipped';
  reason?: string;
  detail?: string;
  watchedCommitMs?: number;
  reportCommitMs?: number;
}
export function committedEvidenceMatchesReport(repoRoot: string, freshReport: unknown): boolean;
export function evaluateReportFreshness(repoRoot: string): ReportFreshnessResult;
export const FRESHNESS_WATCHED_ROOTS: string[];
// Tuple, not string[]: consumers index [0]/[1] in TypeScript tests, where a
// string[] element reads as `string | undefined` under noUncheckedIndexedAccess
// and fails core's test-type ratchet with TS2345.
export const FRESHNESS_REPORT_FILES: [string, string];
export function loadArchitectureInputs(repoRoot: string): Promise<{
  registry: unknown;
  exceptions: unknown;
  hotspots: unknown;
}>;

export const __architectureHealthTestInternals: {
  pathExists(value: string): Promise<boolean>;
  walk(dir: string, predicate: (file: string, name: string) => boolean): Promise<string[]>;
  isTestFile(file: string): boolean;
  stripSourceComments(text: string): string;
  candidatePaths(basePath: string, sourceExtensions: Set<string>): string[];
  resolveRelativeModule(
    fromFile: string,
    specifier: string,
    knownFiles: Set<string>,
    sourceExtensions: Set<string>,
  ): Promise<string | null>;
  findGraphCycles(
    nodes: string[],
    edges: Array<{ from: string; to: string; typeOnly: boolean }>,
    runtimeOnly: boolean,
  ): string[][];
  findPackageCycles(packages: Array<{ name: string; workspaceDependencies: string[] }>): string[][];
  matchesTestProject(
    file: string,
    project: {
      exactFiles?: string[];
      excludeFiles?: string[];
      excludePrefixes?: string[];
      includePrefixes?: string[];
    },
  ): boolean;
  stripJsonComments(text: string): string;
  validateExceptions(
    exceptionDocument: { exceptions?: Array<Record<string, unknown>> },
    activeCycles: Array<{ kind: string; members: string[] }>,
    now: Date,
  ): { errors: string[]; unexcepted: unknown[]; matched: string[] };
};
