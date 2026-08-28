export type LanguageProfileId =
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'rust'
  | 'php'
  | 'csharp'
  | 'python'
  | 'java'
  | 'ruby'
  | 'c'
  | 'cpp'
  | 'swift'
  | 'dart'
  | 'elixir'
  | 'deno'
  | 'shell';

export type LanguageOperation =
  | 'syntax'
  | 'semantic'
  | 'lint'
  | 'format-check'
  | 'format-write'
  | 'test-compile'
  | 'test'
  | 'build'
  | 'run'
  | 'debug-compile'
  | 'debug-test'
  | 'debug-runtime'
  | 'debug-race'
  | 'package-install'
  | 'package-add'
  | 'package-remove'
  | 'package-update'
  | 'package-audit'
  | 'package-outdated';

export type EvidenceKind = 'manifest' | 'lockfile' | 'config' | 'source' | 'target';

export interface DetectorRule {
  kind: Exclude<EvidenceKind, 'source' | 'target'>;
  /** Exact basename, matched case-insensitively. */
  filename?: string | undefined;
  /** Basename suffix, matched case-insensitively (for example `.csproj`). */
  suffix?: string | undefined;
  weight: number;
}

export interface LanguageEvidence {
  kind: EvidenceKind;
  path: string;
  value: string;
  weight: number;
}

export interface DetectedWorkspace {
  id: string;
  language: LanguageProfileId;
  root: string;
  confidence: number;
  evidence: readonly LanguageEvidence[];
  packageManager?: string | undefined;
  manifests: readonly string[];
  capabilities: readonly LanguageOperation[];
}

export interface LanguageOperationOptions {
  target?: string | undefined;
  filter?: string | undefined;
  coverage?: boolean | undefined;
  noRun?: boolean | undefined;
  packages?: string[] | undefined;
  packageScope?: 'runtime' | 'development' | 'optional' | undefined;
  allowScripts?: boolean | undefined;
}

export interface ProfileContext {
  projectRoot: string;
  workspace: DetectedWorkspace;
  target?: string | undefined;
  mode: 'fast' | 'standard' | 'thorough';
  options: LanguageOperationOptions;
  platform: NodeJS.Platform;
  pathExists(path: string): Promise<boolean>;
}

export interface CommandPlan {
  profileId: LanguageProfileId;
  workspaceId: string;
  operation: LanguageOperation;
  kind: 'process' | 'internal';
  command: string | null;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  outputLimitBytes: number;
  mutating: boolean;
  network: boolean;
  executesProjectCode: boolean;
  reason: string;
  evidence: readonly LanguageEvidence[];
  parser: string;
}

export interface LanguageDiagnosticPosition {
  /** One-based line number. */
  line: number;
  /** One-based column number. */
  column: number;
}

export interface LanguageDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string | undefined;
  message: string;
  file?: string | undefined;
  range?:
    | {
        start: LanguageDiagnosticPosition;
        end?: LanguageDiagnosticPosition | undefined;
      }
    | undefined;
  source: string;
}

export interface LanguageRunSummary {
  errors: number;
  warnings: number;
  infos: number;
  tests?: number | undefined;
  passed?: number | undefined;
  failed?: number | undefined;
}

export interface LanguageRunResult {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'timed_out';
  language: LanguageProfileId;
  workspace: DetectedWorkspace;
  plan: CommandPlan;
  exitCode: number | null;
  durationMs: number;
  diagnostics: readonly LanguageDiagnostic[];
  omittedDiagnostics: number;
  summary: LanguageRunSummary;
  output: string;
  truncated: boolean;
  spoolPath?: string | undefined;
  error?: string | undefined;
}

export type PackageMutation =
  | 'package-install'
  | 'package-add'
  | 'package-remove'
  | 'package-update';

export type PackageRead = 'package-audit' | 'package-outdated';

export interface LanguagePackageMutation {
  name: string;
  requested?: string | undefined;
  resolved?: string | undefined;
  previous?: string | undefined;
  kind?: 'runtime' | 'development' | 'optional' | 'transitive' | undefined;
}

export interface LanguagePackageVulnerability {
  package: string;
  advisory?: string | undefined;
  severity: 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
  fixedIn?: string | undefined;
  url?: string | undefined;
}

export interface LanguagePackageOutcome {
  workspace: DetectedWorkspace;
  language: LanguageProfileId;
  operation: LanguageOperation;
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'timed_out';
  run?: LanguageRunResult;
  durationMs: number;
  manifestsBefore: readonly string[];
  lockfilesBefore: readonly string[];
  manifestsAfter: readonly string[];
  lockfilesAfter: readonly string[];
  manifestsChanged: readonly string[];
  lockfilesChanged: readonly string[];
  mutations: readonly LanguagePackageMutation[];
  vulnerabilities: readonly LanguagePackageVulnerability[];
  outdated: readonly LanguagePackageMutation[];
}

export interface UnavailableOperation {
  status: 'unavailable';
  profileId: LanguageProfileId;
  workspaceId: string;
  operation: LanguageOperation;
  reason: string;
}

export type OperationPlanResult = CommandPlan | UnavailableOperation;
type OperationResolver = (ctx: ProfileContext) => Promise<OperationPlanResult>;

export interface LanguageProfile {
  id: LanguageProfileId;
  displayName: string;
  extensions: readonly string[];
  lspLanguageIds: readonly string[];
  detectors: readonly DetectorRule[];
  ignoredDirectories: readonly string[];
  packageManagers: readonly string[];
  /** Executables an operation resolver is allowed to place in a process plan. */
  executables: readonly string[];
  /**
   * When false, extension matches alone never create a workspace for this
   * profile — they only reinforce candidates a detector (manifest/config)
   * already established. Use for profiles whose extensions are shared with
   * another language (e.g. Deno claims .ts/.js).
   */
  sourceFallback?: boolean;
  operations: Readonly<Partial<Record<LanguageOperation, OperationResolver>>>;
}

export interface DetectionLimits {
  maxDepth: number;
  maxEntries: number;
}

export interface DetectLanguageOptions {
  projectRoot: string;
  cwd?: string | undefined;
  target?: string | undefined;
  language?: LanguageProfileId | undefined;
  profiles?: readonly LanguageProfile[] | undefined;
  limits?: Partial<DetectionLimits> | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Extra directory names (basename matches, not paths) to skip during the
   * scan, on top of the built-in global ignores and each profile's
   * `ignoredDirectories`. The project root itself is never skipped even if
   * its basename matches.
   */
  ignoredDirectories?: readonly string[] | undefined;
}

export interface DetectionResult {
  projectRoot: string;
  scannedEntries: number;
  truncated: boolean;
  workspaces: DetectedWorkspace[];
}

export interface PlanLanguageOptions extends DetectLanguageOptions {
  operation: LanguageOperation;
  workspace?: string | undefined;
  mode?: 'fast' | 'standard' | 'thorough' | undefined;
  operationOptions?: LanguageOperationOptions | undefined;
}

export type PlanLanguageResult =
  | {
      status: 'planned';
      workspace: DetectedWorkspace;
      plan: CommandPlan;
    }
  | {
      status: 'unavailable';
      workspace: DetectedWorkspace;
      unavailable: UnavailableOperation;
    }
  | {
      status: 'not_found';
      reason: string;
      candidates: DetectedWorkspace[];
    }
  | {
      status: 'ambiguous';
      reason: string;
      candidates: DetectedWorkspace[];
    };
