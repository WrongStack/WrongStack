/**
 * Skill content structure for generated security skills.
 */
export interface GeneratedSkillContent {
  type: 'skill';
  content: string;
}

export type TechStack =
  | 'nodejs'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'dotnet'
  | 'php'
  | 'ruby'
  | 'cpp'
  | 'c'
  | 'kotlin'
  | 'swift'
  | 'unknown';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'cargo'
  | 'maven'
  | 'gradle'
  | 'nuget'
  | 'composer'
  | 'bundler'
  | 'cmake'
  | 'swiftpm'
  | 'go'
  | 'unknown';

export interface DetectedDependency {
  name: string;
  version: string;
  isDev: boolean;
  hasSecurityIssue?: boolean | undefined;
}

export interface TechStackInfo {
  stack: TechStack;
  packageManager: PackageManager;
  manifestFile: string;
  dependencies: DetectedDependency[];
  projectPath: string;
}

export interface DetectionResult {
  timestamp: string;
  projectRoot: string;
  detectedStacks: TechStackInfo[];
  isMonorepo: boolean;
  workspaceConfigs?: string[] | undefined;
}

export interface SkillGenerationContext {
  techStack: TechStackInfo;
  scanScope: ScanScope;
  severityLevel: SeverityLevel;
}

export type ScanScope = 'quick' | 'standard' | 'deep';

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'all';

export type SecurityFindingCategory =
  | 'secrets'
  | 'injection'
  | 'config'
  | 'dependency'
  | 'filesystem';

export type SecurityPatternConfidence = 'high' | 'medium' | 'low';

export interface SecurityPattern {
  id: string;
  name: string;
  severity: SeverityLevel;
  description: string;
  patterns: RegExp[];
  fileExtensions: string[];
  falsePositiveMarkers: string[];
  remediation: string;
  category?: SecurityFindingCategory | undefined;
  confidence?: SecurityPatternConfidence | undefined;
}

export interface GeneratedSecuritySkill {
  name: string;
  description: string;
  techStack: TechStack;
  patterns: SecurityPattern[];
  rules: string[];
  metadata: {
    generatedAt: string;
    version: string;
    confidence: number;
  };
  content: GeneratedSkillContent;
}

/**
 * Module-level re-exports — kept here so `orchestrator.ts` can import the
 * skill / gitignore / detector result types from a single place instead
 * of forwarding `import('./skill-generator.js').GeneratedSkill`. These are
 * verbatim aliases of the original interfaces defined in their owning
 * modules; no cast, no structural drift.
 */
export type { GeneratedSkill } from './skill-generator.js';

/**
 * Inline alias — `gitignore-updater.ts` no longer exports
 * `GitignoreUpdateResult` directly (orchestrator.ts moved the field set
 * inline). Re-declared here so `orchestrator.ts` can keep a single import
 * surface. Structural shape matches the prior definition verbatim.
 */
export interface GitignoreUpdateResult {
  added: string[];
  existing: string[];
  errors: string[];
  updated?: string[];
  skipped?: string[];
  message?: string;
}

/**
 * Backward compatibility alias for DetectionResult.
 */
export type TechStackDetectionResult = DetectionResult;
