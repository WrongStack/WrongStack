/**
 * Card 7B-2: Skill generation extracted from orchestrator.ts.
 *
 * Owns the project-specific security skill flow:
 *  - `gatherProjectInfo` (read key files, list dirs)
 *  - `generateSkillLLM` (LLM-rendered dynamic skill)
 *  - `generateFallbackSkill` (safe static fallback when LLM fails)
 *
 * Pure module — no class state, no orchestration concerns. The
 * orchestrator drives it via `generateSkill()`.
 */

import * as path from 'node:path';

import type { Provider, Request } from '@wrongstack/core/types';
import type { GeneratedSkillContent, SecurityPattern, TechStack, TechStackInfo } from './types.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
  sanitizeJsonString,
  toErrorMessage,
} from '@wrongstack/core/utils';

import { retryProviderComplete } from './llm-client.js';
import { extractJsonBlock } from './json-extractor.js';
import { readFileHead } from './file-gathering.js';

/**
 * Public skill payload returned from `generateSkillLLM` and the static
 * `generateFallbackSkill` helper. Re-exported here (rather than left
 * inline) so consumers (batch-scanner.ts, scanner.ts, orchestrator.ts)
 * can type their skill inputs uniformly — the type was inline in
 * orchestrator.ts before the #7B extraction.
 */
export type GeneratedSkill = {
  name: string;
  description: string;
  version: string;
  techStack: TechStack;
  content: GeneratedSkillContent;
  patterns: SecurityPattern[];
  metadata: {
    generatedAt: string;
    confidence: number;
    targetFiles: string[];
  };
};

const KEY_FILE_HEAD_CHARS = 1000;

const KEY_FILES = [
  'package.json',
  'tsconfig.json',
  '.env.example',
  'README.md',
  'CONTRIBUTING.md',
] as const;

export interface SkillGeneratorOptions {
  includeSecrets?: boolean;
  includeInjection?: boolean;
  includeConfig?: boolean;
  includeDependencies?: boolean;
  severityThreshold?: 'critical' | 'high' | 'medium' | 'low' | 'all';
  provider?: Provider;
  completeWithRetry?: (
    provider: Provider,
    request: Request,
    abortController: AbortController,
  ) => Promise<Awaited<ReturnType<Provider['complete']>>>;
}

export type SkillGeneratorDeps = SkillGeneratorOptions;

const DEFAULT_OPTIONS: SkillGeneratorOptions = {
  includeSecrets: true,
  includeInjection: true,
  includeConfig: true,
  includeDependencies: true,
  severityThreshold: 'all',
};

const SEVERITY_LEVELS: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  all: 0,
};

function getSecretPatterns(stack: TechStack): SecurityPattern[] {
  const commonSecrets: SecurityPattern = {
    id: 'hardcoded-secrets',
    name: 'Hardcoded Secrets',
    severity: 'critical',
    description: 'Detects hardcoded API keys, tokens, passwords, and private keys',
    patterns: [
      /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*['"][a-zA-Z0-9_\-]{8,}['"]/gi,
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
      /ghp_[a-zA-Z0-9]{36}/g,
      /glpat-[a-zA-Z0-9_\-]{20}/g,
      /sk-[a-zA-Z0-9]{32,}/g,
      /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
      /AIza[0-9A-Za-z\-_]{35}/g,
      /AKIA[0-9A-Z]{16}/g,
    ],
    fileExtensions: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.cs', '.php', '.rb', '.env', '.json', '.yaml', '.yml'],
    falsePositiveMarkers: ['example', 'placeholder', 'dummy', 'test', 'mock', 'fake', 'sample'],
    remediation: 'Move secrets to environment variables or a secrets manager.',
    category: 'secrets',
    confidence: 'medium',
  };

  const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
    nodejs: [
      {
        id: 'jwt-secret',
        name: 'Hardcoded JWT Secret',
        severity: 'high',
        description: 'Detects hardcoded secrets in JWT signing/verification',
        patterns: [/jwt\.sign\s*\([^,]+,\s*['"][^'"]+['"]/g, /jwt\.verify\s*\([^,]+,\s*['"][^'"]+['"]/g],
        fileExtensions: ['.ts', '.js'],
        falsePositiveMarkers: ['process.env'],
        remediation: 'Use environment variables for JWT secret keys.',
        category: 'secrets',
        confidence: 'high',
      },
      {
        id: 'npmrc-credentials',
        name: 'npmrc Credentials',
        severity: 'high',
        description: 'Detects auth tokens in .npmrc files',
        patterns: [/:\/\/[^/]+\/:_authToken\s*=\s*[^\s]+/g],
        fileExtensions: ['.npmrc'],
        falsePositiveMarkers: ['${', '$AUTH_TOKEN'],
        remediation: 'Use environment variable interpolation in .npmrc: //registry.npmjs.org/:_authToken=${NPM_TOKEN}',
        category: 'secrets',
        confidence: 'high',
      },
    ],
    python: [
      {
        id: 'python-secret-env',
        name: 'Hardcoded SECRET_KEY in Django/Flask',
        severity: 'critical',
        description: 'Detects hardcoded SECRET_KEY in Python web frameworks',
        patterns: [/SECRET_KEY\s*=\s*['"][^'"]{8,}['"]/g],
        fileExtensions: ['.py'],
        falsePositiveMarkers: ['os.environ', 'os.getenv', 'config('],
        remediation: 'Load SECRET_KEY from environment: os.environ.get("SECRET_KEY")',
        category: 'secrets',
        confidence: 'high',
      },
    ],
    rust: [
      {
        id: 'rust-env-secrets',
        name: 'Hardcoded Secrets in Rust',
        severity: 'critical',
        description: 'Detects hardcoded credentials in Rust source files',
        patterns: [/const\s+[A-Z_]*SECRET[A-Z_]*\s*:\s*&str\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.rs'],
        falsePositiveMarkers: ['std::env::var'],
        remediation: 'Use std::env::var to read secrets at runtime.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    go: [
      {
        id: 'go-hardcoded-secret',
        name: 'Hardcoded Secret in Go',
        severity: 'critical',
        description: 'Detects hardcoded secret constants in Go',
        patterns: [/const\s+[a-zA-Z_]*[sS]ecret[a-zA-Z_]*\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.go'],
        falsePositiveMarkers: ['os.Getenv'],
        remediation: 'Use os.Getenv to read secrets at runtime.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    java: [
      {
        id: 'java-system-getenv',
        name: 'Hardcoded Secrets in Java',
        severity: 'critical',
        description: 'Detects hardcoded secret fields in Java classes',
        patterns: [/(?:private|public|protected)\s+(?:static\s+)?(?:final\s+)?String\s+[A-Z_]*SECRET[A-Z_]*\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.java'],
        falsePositiveMarkers: ['System.getenv', 'System.getProperty'],
        remediation: 'Use System.getenv() or Spring @Value("${...}") for secrets.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    dotnet: [
      {
        id: 'dotnet-config-secrets',
        name: 'Hardcoded Secrets in .NET',
        severity: 'critical',
        description: 'Detects hardcoded secret constants in C#',
        patterns: [/(?:const|readonly)\s+string\s+[A-Za-z_]*[sS]ecret[A-Za-z_]*\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.cs'],
        falsePositiveMarkers: ['Configuration[', 'Environment.GetEnvironmentVariable'],
        remediation: 'Use IConfiguration or user secrets in .NET.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
  };

  return [commonSecrets, ...(stackSpecific[stack] ?? [])].map((pattern) => ({
    ...pattern,
    category: 'secrets',
    confidence: pattern.confidence ?? 'medium',
  }));
}

function getInjectionPatterns(stack: TechStack): SecurityPattern[] {
  const commonInjection: SecurityPattern = {
    id: 'command-injection',
    name: 'Command Injection',
    severity: 'critical',
    description: 'Detects execution of system commands with concatenated user input',
    patterns: [
      /exec\s*\([^)]*\+/g,
      /execSync\s*\([^)]*\+/g,
      /spawn\s*\([^,]+,\s*\{[^}]*shell:\s*true/g,
      /system\s*\([^)]*\+/g,
      /popen\s*\([^)]*\+/g,
    ],
    fileExtensions: ['.ts', '.js', '.php', '.py', '.rb'],
    falsePositiveMarkers: ['escapeshellarg', 'escapeshellcmd', 'sanitize'],
    remediation: 'Use parameterized commands with argument arrays instead of string interpolation.',
    category: 'injection',
    confidence: 'medium',
  };

  const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
    nodejs: [
      {
        id: 'eval-user-input',
        name: 'Eval with User Input',
        severity: 'critical',
        description: 'Detects eval() or Function() constructor with variables',
        patterns: [/eval\s*\([^'"][^)]*\)/g, /new\s+Function\s*\([^'"][^)]*\)/g],
        fileExtensions: ['.ts', '.js'],
        falsePositiveMarkers: ['JSON.parse'],
        remediation: 'Never eval user input. Use JSON.parse for data, or proper sandboxing.',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'sql-injection-template',
        name: 'SQL Injection via Template Literal',
        severity: 'critical',
        description: 'Detects SQL queries built with template literals containing expressions',
        patterns: [
          /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s+.*?\$\{/gi,
          /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
        ],
        fileExtensions: ['.ts', '.js'],
        falsePositiveMarkers: ['sql`', 'Prisma.sql`'],
        remediation: 'Use parameterized queries: query("SELECT * FROM users WHERE id = $1", [id])',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'nosql-injection',
        name: 'NoSQL Injection',
        severity: 'high',
        description: 'Detects NoSQL query injection via user input',
        patterns: [/find\s*\(\s*\{.*\$where/g, /collection\.(?:find|aggregate)\s*\([^)]*\$/g],
        fileExtensions: ['.ts', '.js'],
        falsePositiveMarkers: [],
        remediation: 'Sanitize and validate all user input before NoSQL queries.',
        category: 'injection',
        confidence: 'medium',
      },
    ],
    python: [
      {
        id: 'python-sql-injection',
        name: 'Python SQL Injection',
        severity: 'critical',
        description: 'Detects SQL queries built with string formatting',
        patterns: [/execute\s*\(\s*f?["'].*%.*/g, /cursor\.execute\s*\([^)]*\+[^)]*\)/g],
        fileExtensions: ['.py'],
        falsePositiveMarkers: ['%s', '%d', '?', 'parameterized'],
        remediation: 'Use parameterized queries with cursor.execute(query, params).',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'pickle-deserialization',
        name: 'Pickle Deserialization',
        severity: 'critical',
        description: 'Detects insecure pickle deserialization',
        patterns: [/pickle\.load\s*\(/g, /pickle\.loads\s*\(/g, /unpickle\.load\s*\(/g],
        fileExtensions: ['.py'],
        falsePositiveMarkers: [],
        remediation: 'Never unpickle data from untrusted sources. Use JSON or custom serialization.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    go: [
      {
        id: 'go-sql-injection',
        name: 'Go SQL Injection',
        severity: 'critical',
        description: 'Detects SQL queries with string concatenation',
        patterns: [/db\.Query\s*\([^)]*\+[^)]*\)/g, /QueryContext?\s*\([^)]*\+[^)]*\)/g],
        fileExtensions: ['.go'],
        falsePositiveMarkers: ['$1', '$2', '?', 'params'],
        remediation: 'Use parameterized queries: db.QueryContext(ctx, "SELECT * FROM users WHERE id=?", userID)',
        category: 'injection',
        confidence: 'high',
      },
    ],
    java: [
      {
        id: 'java-sql-injection',
        name: 'Java SQL Injection',
        severity: 'critical',
        description: 'Detects SQL with string concatenation in JDBC',
        patterns: [/createStatement\s*\(\s*\).*\.executeQuery\s*\([^)]*\+/g, /Statement\s*\([^)]*\+/g],
        fileExtensions: ['.java'],
        falsePositiveMarkers: ['PreparedStatement', '?'],
        remediation: 'Use PreparedStatement with parameters.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    rust: [
      {
        id: 'rust-command-injection',
        name: 'Rust Command Injection',
        severity: 'critical',
        description: 'Detects Command::new with string interpolation',
        patterns: [/Command::new\s*\([^)]*\)\s*\.(?:arg|args)\s*\([^)]*\+/g, /Command::from\s*\(/g],
        fileExtensions: ['.rs'],
        falsePositiveMarkers: ['Command::new', 'args\\('],
        remediation: 'Use Command::new(array).args(&[...]) to avoid shell injection.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    dotnet: [
      {
        id: 'csharp-sql-injection',
        name: 'C# SQL Injection',
        severity: 'critical',
        description: 'Detects SQL with string concatenation in C#',
        patterns: [/SqlCommand\s*\([^)]*\+[^)]*\)/g, /\.ExecuteQuery\s*\([^)]*\+[^)]*\)/g],
        fileExtensions: ['.cs'],
        falsePositiveMarkers: ['parameters.Add', '@', 'SqlParameter'],
        remediation: 'Use parameterized queries with SqlParameter.',
        category: 'injection',
        confidence: 'high',
      },
    ],
  };

  return [commonInjection, ...(stackSpecific[stack] ?? [])].map((pattern) => ({
    ...pattern,
    category: 'injection',
    confidence: pattern.confidence ?? 'medium',
  }));
}

function getConfigPatterns(_stack: TechStack): SecurityPattern[] {
  const commonConfig: SecurityPattern[] = [
    {
      id: 'insecure-tls',
      name: 'Insecure TLS Configuration',
      severity: 'high',
      description: 'Detects disabled TLS verification or weak TLS settings',
      patterns: [
        /rejectUnauthorized\s*[:=]\s*false/g,
        /secure\s*[:=]\s*false/g,
        /ssl\s*[:=]\s*false/g,
        /TLS\s*\[\s*['"]?1\.0['"]?\]/gi,
        /InsecureRequestWarning\.disable/g,
      ],
      fileExtensions: ['.ts', '.js', '.py', '.go', '.java'],
      falsePositiveMarkers: ['NODE_TLS_REJECT_UNAUTHORIZED'],
      remediation: 'Always verify TLS certificates in production. Use proper certificate stores.',
      category: 'config',
      confidence: 'medium',
    },
    {
      id: 'debug-enabled',
      name: 'Debug Mode Enabled',
      severity: 'medium',
      description: 'Detects debug flags that may expose sensitive information',
      patterns: [/debug\s*[:=]\s*true/g, /DEBUG\s*[:=]\s*true/g, /development\s*mode/g],
      fileExtensions: ['.ts', '.js', '.py', '.env', '.json'],
      falsePositiveMarkers: ['process.env.NODE_ENV !== "production"', 'if (process.env.DEBUG)'],
      remediation: 'Disable debug mode in production. Use proper log levels.',
      category: 'config',
      confidence: 'low',
    },
  ];

  return commonConfig;
}

function getTargetFilesForStack(techStack: TechStackInfo): string[] {
  const filesByStack: Record<TechStack, string[]> = {
    nodejs: ['**/*.ts', '**/*.js', '**/*.json', '**/.env*', '**/package.json', '**/tsconfig.json'],
    python: ['**/*.py', '**/requirements*.txt', '**/setup.py', '**/pyproject.toml', '**/.env*'],
    rust: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock'],
    go: ['**/*.go', '**/go.mod', '**/go.sum'],
    java: ['**/*.java', '**/pom.xml', '**/build.gradle', '**/*.properties'],
    dotnet: ['**/*.cs', '**/*.csproj', '**/*.config', '**/appsettings.json'],
    php: ['**/*.php', '**/.env*', '**/composer.json'],
    ruby: ['**/*.rb', '**/Gemfile', '**/.env*'],
    cpp: ['**/*.cpp', '**/*.hpp', '**/CMakeLists.txt'],
    c: ['**/*.c', '**/*.h'],
    kotlin: ['**/*.kt', '**/*.kts', '**/build.gradle.kts'],
    swift: ['**/*.swift', '**/Package.swift'],
    unknown: ['**/*'],
  };

  return filesByStack[techStack.stack] || filesByStack.unknown || ['**/*'];
}

function buildSkillContent(techStack: TechStackInfo, patterns: SecurityPattern[]): GeneratedSkillContent {
  const lines: string[] = [
    '---',
    `name: security-scanner-${techStack.stack}`,
    `description: |`,
    `  Auto-generated security scanner for ${techStack.stack} projects.`,
    `  Scans for secrets, injection vectors, and configuration issues.`,
    `version: 1.0.0`,
    '---',
    '',
    `# Security Scanner — ${techStack.stack.toUpperCase()}`,
    '',
    `Scans ${techStack.stack} codebase for security vulnerabilities.`,
    '',
    '## Scan Targets',
    '',
    '### Code Vulnerabilities',
    patterns
      .filter((p) =>
        p.fileExtensions.some((ext) =>
          ['.ts', '.js', '.py', '.go', '.java', '.cs', '.rs'].includes(ext),
        ),
      )
      .map((p) => `- **${p.name}** (${p.severity}): ${p.description}`)
      .join('\n'),
    '',
    '### Configuration Issues',
    patterns
      .filter((p) =>
        p.fileExtensions.some((ext) =>
          ['.json', '.yaml', '.yml', '.env', '.config'].includes(ext),
        ),
      )
      .map((p) => `- **${p.name}** (${p.severity}): ${p.description}`)
      .join('\n'),
    '',
    '## Severity Levels',
    '',
    '- **CRITICAL**: Remote code execution, SQL injection, hardcoded secrets',
    '- **HIGH**: Command injection, XXE, authentication bypass',
    '- **MEDIUM**: Information disclosure, weak crypto, debug mode',
    '- **LOW**: Code quality issues, missing headers',
    '',
    '## Remediation',
    '',
    patterns.map((p) => `- **${p.name}**: ${p.remediation}`).join('\n'),
  ];

  return {
    type: 'skill',
    content: lines.join('\n'),
  };
}

function calculateConfidence(techStack: TechStackInfo): number {
  let confidence = 0.7;
  if (techStack.dependencies && techStack.dependencies.length > 0) confidence += 0.1;
  if (techStack.manifestFile) confidence += 0.1;
  if (techStack.packageManager && techStack.packageManager !== 'unknown') confidence += 0.1;
  return Math.min(confidence, 1.0);
}

/**
 * Reads the small set of manifest + docs files that drive `generate-skill.md`
 * prompting. Returns a single string suitable for injection as `projectInfo`.
 */
export async function gatherProjectInfo(
  projectRoot: string,
  _techStack: TechStackInfo,
): Promise<string> {
  const info: string[] = [];

  for (const file of KEY_FILES) {
    try {
      const content = await readFileHead(
        path.join(projectRoot, file),
        KEY_FILE_HEAD_CHARS,
      );
      const displayName =
        file === 'README.md' || file === 'CONTRIBUTING.md' ? 'README' : file;
      info.push(`\n--- ${displayName} ---\n${content}`);
    } catch {
      // File doesn't exist, skip
    }
  }

  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, 20);
    info.push(`\n--- Project Directories ---\n${dirs.join(', ')}`);
  } catch {
    // Skip
  }

  return info.join('\n');
}

/** LLM-rendered dynamic skill; falls back to a static skill on parse error. */
export async function generateSkillLLM(
  deps: SkillGeneratorDeps,
  provider: Provider,
  model: string | undefined,
  projectRoot: string,
  techStack: TechStackInfo,
  abortController: AbortController,
): Promise<GeneratedSkill> {
  const projectInfo = await gatherProjectInfo(projectRoot, techStack);

  const prompt = renderInstructionTemplate(
    readBundledInstructionText('security-scanner/generate-skill.md'),
    {
      projectInfo,
      stack: techStack.stack,
      packageManager: techStack.packageManager,
      manifestFile: techStack.manifestFile,
      dependencies: techStack.dependencies
        .slice(0, 20)
        .map((d) => `- ${d.name}@${d.version}`)
        .join('\n'),
      nodeFocus:
        techStack.stack === 'nodejs'
          ? 'Node.js specific: eval, prototype pollution, npm script injection, express middleware issues, passport.js misconfigs'
          : '',
      pythonFocus:
        techStack.stack === 'python'
          ? 'Python specific: pickle deserialization, SQL injection in ORMs, template injection, insecure Django/Flask settings'
          : '',
    },
  );

  const request: Request = {
    model: model ?? 'unknown',
    system: [
      { type: 'text', text: readBundledInstructionText('security-scanner/json-system.md') },
    ],
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
  };

  try {
    const completeWithRetry = deps.completeWithRetry ?? ((p, req, ac) =>
      retryProviderComplete({
        provider: p,
        request: req,
        abortController: ac,
        retryPolicy: undefined,
        errorHandler: undefined,
      }));
    const response = await completeWithRetry(provider, request, abortController);
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonBlock = extractJsonBlock(text, 'object');
    if (jsonBlock) {
      const sanitized = sanitizeJsonString(jsonBlock) || jsonBlock;
      const skillData = JSON.parse(sanitized);
      return {
        name: skillData.name || `security-scanner-${techStack.stack}`,
        description: skillData.description || `Security scanner for ${techStack.stack}`,
        version: '1.0.0',
        techStack: techStack.stack,
        content: { type: 'skill', content: JSON.stringify(skillData, null, 2) },
        patterns: skillData.patterns || [],
        metadata: {
          generatedAt: new Date().toISOString(),
          confidence: 0.85,
          targetFiles: skillData.targetFiles || [],
        },
      };
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'security_scanner.skill_generation_failed',
        message: toErrorMessage(err),
        techStack: techStack.stack,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return generateFallbackSkill(techStack);
}

/** Static skill — used when LLM generation fails or returns unparsable JSON. */
export function generateFallbackSkill(techStack: TechStackInfo): GeneratedSkill {
  const skill = new SkillGenerator().generate(techStack);
  return {
    ...skill,
    metadata: {
      ...skill.metadata,
      confidence: 0.5,
    },
  };
}

/**
 * Cast-free class wrapper around the free-function helpers above so that
 * `orchestrator.ts` can compose them under a single instance field.
 * Construct via `new SkillGenerator({ completeWithRetry: this.completeWithRetry.bind(this) })`.
 */
export class SkillGenerator {
  private readonly options: SkillGeneratorOptions;

  constructor(options: SkillGeneratorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  generate(techStack: TechStackInfo): GeneratedSkill {
    const allPatterns: SecurityPattern[] = [];

    if (this.options.includeSecrets) {
      allPatterns.push(...getSecretPatterns(techStack.stack));
    }
    if (this.options.includeInjection) {
      allPatterns.push(...getInjectionPatterns(techStack.stack));
    }
    if (this.options.includeConfig) {
      allPatterns.push(...getConfigPatterns(techStack.stack));
    }

    const minSeverity = SEVERITY_LEVELS[this.options.severityThreshold ?? 'all'] ?? 0;
    const filteredPatterns = allPatterns.filter(
      (p) => (SEVERITY_LEVELS[p.severity] ?? 0) >= minSeverity,
    );

    const targetFiles = getTargetFilesForStack(techStack);
    const content = buildSkillContent(techStack, filteredPatterns);
    const confidence = calculateConfidence(techStack);

    return {
      name: `security-scanner-${techStack.stack}`,
      description: `Security scanner for ${techStack.stack} projects`,
      version: '1.0.0',
      techStack: techStack.stack,
      content,
      patterns: filteredPatterns,
      metadata: {
        generatedAt: new Date().toISOString(),
        confidence,
        targetFiles,
      },
    };
  }

  gatherProjectInfo(projectRoot: string, techStack: TechStackInfo): Promise<string> {
    return gatherProjectInfo(projectRoot, techStack);
  }

  generateSkillLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    techStack: TechStackInfo,
    abortController: AbortController,
  ): Promise<GeneratedSkill> {
    const deps = {
      ...(this.options.provider ? { provider: this.options.provider } : {}),
      completeWithRetry:
        this.options.completeWithRetry ??
        ((p, req, ac) =>
          retryProviderComplete({
            provider: p,
            request: req,
            abortController: ac,
            retryPolicy: undefined,
            errorHandler: undefined,
          })),
    };
    return generateSkillLLM(deps, provider, model, projectRoot, techStack, abortController);
  }

  generateFallbackSkill(techStack: TechStackInfo): GeneratedSkill {
    return this.generate(techStack);
  }
}

/**
 * Default `SkillGenerator` singleton wired with a vanilla retry path.
 * Useful for callers that don't have an orchestrator-injected
 * `completeWithRetry` (CLI scripts, tests, the scanner).
 */
export const defaultSkillGenerator = new SkillGenerator({
  completeWithRetry: (provider, request, abortController) =>
    retryProviderComplete({
      provider,
      request,
      abortController,
      retryPolicy: undefined,
      errorHandler: undefined,
    }),
});

// `retryProviderComplete` re-export kept for callers that prefer the lower-level API.
export { retryProviderComplete };
