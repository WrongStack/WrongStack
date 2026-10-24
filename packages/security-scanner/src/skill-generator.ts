import { parseSkillFrontmatter } from '@wrongstack/core/skills';
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

import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

import type { Provider, Request } from '@wrongstack/contracts/types';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
  sanitizeJsonString,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { readFileHead } from './file-gathering.js';
import { extractJsonBlock } from './json-extractor.js';
import { retryProviderComplete } from './llm-client.js';
import { getTargetFilesForStack } from './scan-targets.js';
import { getConfigPatterns, getInjectionPatterns, getSecretPatterns } from './skill-patterns.js';
import { buildSkillContent, calculateConfidence, renderGeneratedSkill } from './skill-rendering.js';
import type { GeneratedSkill, SecurityPattern, TechStackInfo } from './types.js';

/**
 * Public skill payload returned from `generateSkillLLM` and the static
 * `generateFallbackSkill` helper. Re-exported here (rather than left
 * inline) so consumers (batch-scanner.ts, scanner.ts, orchestrator.ts)
 * can type their skill inputs uniformly — the type was inline in
 * orchestrator.ts before the #7B extraction.
 */
export type { GeneratedSkill } from './types.js';

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

/**
 * Reads the small set of manifest + docs files that drive `generate-skill.md`
 * prompting. Returns a single string suitable for injection as `projectInfo`.
 */
export async function gatherProjectInfo(
  projectRoot: string,
  _techStack: TechStackInfo,
): Promise<string> {
  const info: string[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch {
    return '';
  }

  for (const file of KEY_FILES) {
    try {
      const resolvedFile = await realpath(path.join(canonicalRoot, file));
      const relativeFile = path.relative(canonicalRoot, resolvedFile);
      if (
        relativeFile === '..' ||
        relativeFile.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeFile)
      )
        continue;
      const content = await readFileHead(resolvedFile, KEY_FILE_HEAD_CHARS);
      const displayName = file === 'README.md' || file === 'CONTRIBUTING.md' ? 'README' : file;
      info.push(`\n--- ${displayName} ---\n${content}`);
    } catch {
      // File doesn't exist, skip
    }
  }

  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
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
    system: [{ type: 'text', text: readBundledInstructionText('security-scanner/json-system.md') }],
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
  };

  try {
    const completeWithRetry =
      deps.completeWithRetry ??
      ((p, req, ac) =>
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
      const content = renderGeneratedSkill(skillData, techStack.stack);
      const frontmatter = parseSkillFrontmatter(content);
      return {
        name: frontmatter.name ?? `security-scanner-${techStack.stack}`,
        description: frontmatter.description ?? `Security scanner for ${techStack.stack}`,
        version: '1.0.0',
        techStack: techStack.stack,
        content: { type: 'skill', content },
        patterns: skillData.patterns || [],
        metadata: {
          generatedAt: new Date().toISOString(),
          confidence: 0.85,
          // The stack's own list is the floor: the model's list decides what
          // gets read, and one that forgot `.tsx` left every component unscanned.
          targetFiles: [
            ...new Set([
              ...(Array.isArray(skillData.targetFiles)
                ? (skillData.targetFiles as unknown[]).filter(
                    (p): p is string => typeof p === 'string',
                  )
                : []),
              ...getTargetFilesForStack(techStack),
            ]),
          ],
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
    const filteredPatterns = allPatterns.filter((p) => SEVERITY_LEVELS[p.severity]! >= minSeverity);

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
