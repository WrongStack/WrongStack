import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { DEFAULT_EXCLUDE_PATTERNS, gatherFiles } from './file-gathering.js';
import type {
  SecurityFindingCategory,
  SecurityPattern,
  SecurityPatternConfidence,
  TechStackInfo,
} from './types.js';
import type { GeneratedSkill } from './skill-generator.js';

export interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: SecurityFindingCategory;
  title: string;
  description: string;
  file: string;
  line?: number | undefined;
  snippet?: string | undefined;
  remediation: string;
  patternId: string;
  confidence: SecurityPatternConfidence;
}

export interface ScanResult {
  timestamp: string;
  projectRoot: string;
  techStack: TechStackInfo;
  findings: Finding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  scannedFiles: number;
  scanDurationMs: number;
  errors: string[];
}

export interface ScanOptions {
  includeSecrets: boolean;
  includeInjection: boolean;
  includeConfig: boolean;
  includeDependencies: boolean;
  excludePaths: string[];
  fileExtensions: string[];
  depth: 'quick' | 'standard' | 'deep';
  fileConcurrency: number;
}

const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  includeSecrets: true,
  includeInjection: true,
  includeConfig: true,
  includeDependencies: true,
  excludePaths: [...DEFAULT_EXCLUDE_PATTERNS],
  fileExtensions: [],
  depth: 'standard',
  fileConcurrency: 10,
};

export class SecurityScanner {
  private options: ScanOptions;

  constructor(options: Partial<ScanOptions> = {}) {
    this.options = { ...DEFAULT_SCAN_OPTIONS, ...options };
  }

  async scan(
    projectRoot: string,
    skill: GeneratedSkill,
    techStack: TechStackInfo,
  ): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    let scannedFiles = 0;

    const targetExtensions = this.getTargetExtensions(skill, techStack);
    const maxDepth = this.options.depth === 'quick' ? 2 : this.options.depth === 'deep' ? 20 : 5;
    const files = await gatherFiles({
      root: projectRoot,
      extensions: targetExtensions,
      maxDepth,
      excludePatterns: this.options.excludePaths,
    });

    const concurrency = Math.max(1, Math.floor(this.options.fileConcurrency));
    for (let index = 0; index < files.length; index += concurrency) {
      const batch = files.slice(index, index + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const content = await readFile(file, 'utf-8');
          const relativePath = relative(projectRoot, file).replace(/\\/g, '/');
          return this.scanFile(content, relativePath, skill.patterns, skill.metadata.confidence);
        }),
      );
      results.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          findings.push(...result.value);
          scannedFiles++;
        } else {
          errors.push(`Failed to read ${batch[batchIndex]!}: ${result.reason}`);
        }
      });
    }

    // Sort findings by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const summary = this.calculateSummary(findings);
    const scanDurationMs = Date.now() - startTime;

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      techStack,
      findings,
      summary,
      scannedFiles,
      scanDurationMs,
      errors,
    };
  }

  private getTargetExtensions(skill: GeneratedSkill, _techStack: TechStackInfo): string[] {
    if (this.options.fileExtensions.length > 0) {
      return this.options.fileExtensions
        .filter((ext) => typeof ext === 'string' && ext.trim().length > 0)
        .map((ext) => {
          const lower = ext.toLowerCase().trim();
          return lower.startsWith('.') ? lower : `.${lower}`;
        });
    }

    const extensions = new Set<string>();
    for (const pattern of skill.patterns) {
      for (const ext of pattern.fileExtensions) {
        if (!ext || typeof ext !== 'string') continue;
        const lower = ext.toLowerCase().trim();
        if (lower) {
          extensions.add(lower.startsWith('.') ? lower : `.${lower}`);
        }
      }
    }

    return [...extensions];
  }

  private scanFile(
    content: string,
    relativePath: string,
    patterns: SecurityPattern[],
    skillConfidence: number,
  ): Finding[] {
    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (const pattern of patterns) {
      if (!this.matchesCategory(pattern)) continue;
      if (pattern.fileExtensions && pattern.fileExtensions.length > 0) {
        const lowerPath = relativePath.toLowerCase();
        const baseName = lowerPath.split('/').pop() ?? lowerPath;
        const matchesExt = pattern.fileExtensions.some((ext) => {
          if (!ext || typeof ext !== 'string') return false;
          const lowerExt = ext.toLowerCase().trim();
          const normalizedExt = lowerExt.startsWith('.') ? lowerExt : `.${lowerExt}`;
          return (
            lowerPath.endsWith(normalizedExt) ||
            (normalizedExt === '.env' && baseName.startsWith('.env'))
          );
        });
        if (!matchesExt) continue;
      }

      const matchedLines = new Set<number>();
      for (const regex of pattern.patterns ?? []) {
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          if (matchedLines.has(lineNum)) continue;
          const line = lines[lineNum];
          if (!line) continue;

          // Reset INSIDE the line loop: pattern.patterns are declared with
          // the /g flag (see skill-generator.ts), and `.test()` on a /g regex
          // advances `lastIndex` between calls. A match on line N leaves
          // `lastIndex` past the end of line N+1's string, silently skipping
          // every subsequent match — turning the scanner into a one-finding-
          // per-file tool. Reset here so each line gets a fresh search.
          regex.lastIndex = 0;

          if (regex.test(line)) {
            matchedLines.add(lineNum);
            // Check false positive markers
            if (this.isFalsePositive(line, pattern.falsePositiveMarkers)) {
              continue;
            }

            findings.push({
              id: `${pattern.id}-${relativePath}-${lineNum + 1}`,
              severity: pattern.severity as Finding['severity'],
              category: this.getCategoryFromPattern(pattern),
              title: pattern.name,
              description: pattern.description,
              file: relativePath,
              line: lineNum + 1,
              snippet: line.trim(),
              remediation: pattern.remediation,
              patternId: pattern.id,
              confidence: this.getConfidence(pattern, skillConfidence, relativePath, line),
            });
          }
        }
      }
    }

    return findings;
  }

  private matchesCategory(pattern: SecurityPattern): boolean {
    switch (this.getCategoryFromPattern(pattern)) {
      case 'secrets':
        return this.options.includeSecrets;
      case 'injection':
        return this.options.includeInjection;
      case 'config':
        return this.options.includeConfig;
      case 'dependency':
        return this.options.includeDependencies;
      default:
        return true;
    }
  }

  private getCategoryFromPattern(pattern: SecurityPattern): Finding['category'] {
    if (pattern.category) return pattern.category;
    if (pattern.id.includes('secret') || pattern.id.includes('npmrc') || pattern.id.includes('env'))
      return 'secrets';
    if (
      pattern.id.includes('injection') ||
      pattern.id.includes('sql') ||
      pattern.id.includes('command') ||
      pattern.id.includes('eval')
    )
      return 'injection';
    if (pattern.id.includes('config') || pattern.id.includes('tls') || pattern.id.includes('debug'))
      return 'config';
    if (pattern.id.includes('dependency')) return 'dependency';
    return 'filesystem';
  }

  private getConfidence(
    pattern: SecurityPattern,
    skillConfidence: number,
    relativePath: string,
    line: string,
  ): Finding['confidence'] {
    const levels: Finding['confidence'][] = ['low', 'medium', 'high'];
    const skillDefault =
      skillConfidence >= 0.85 ? 'high' : skillConfidence >= 0.65 ? 'medium' : 'low';
    let index = levels.indexOf(pattern.confidence ?? skillDefault);
    const normalizedPath = relativePath.toLowerCase();
    const isTestContext =
      /(^|\/)(?:__tests__|tests?|fixtures?|mocks?)(\/|$)/.test(normalizedPath) ||
      /\.(?:test|spec)\.[^.]+$/.test(normalizedPath) ||
      /\b(?:example|placeholder|dummy|mock)\b/i.test(line);
    if (isTestContext) index = Math.max(0, index - 1);
    return levels[index] ?? 'medium';
  }

  private isFalsePositive(line: string, markers?: string[]): boolean {
    if (!markers || markers.length === 0) return false;
    for (const marker of markers) {
      if (line.includes(marker)) {
        return true;
      }
    }
    return false;
  }

  private calculateSummary(findings: Finding[]): ScanResult['summary'] {
    return {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      total: findings.length,
    };
  }
}

export const defaultSecurityScanner = new SecurityScanner();
