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

export interface SkillGeneratorDeps {
  /** Provider used when callers don't have an orchestrator-injected one (CLI, scanner). */
  provider?: Provider;
  /** Provides retry behavior for LLM calls — pass this orchestrator's RetryPolicy/ErrorHandler. */
  completeWithRetry(
    provider: Provider,
    request: Request,
    abortController: AbortController,
  ): Promise<Awaited<ReturnType<Provider['complete']>>>;
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
    const response = await deps.completeWithRetry(provider, request, abortController);
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
  return {
    name: `security-scanner-${techStack.stack}`,
    description: `Security scanner for ${techStack.stack} projects`,
    version: '1.0.0',
    techStack: techStack.stack,
    content: { type: 'skill', content: 'Fallback static skill' },
    patterns: [
      {
        id: 'hardcoded-secrets',
        name: 'Hardcoded Secrets',
        severity: 'critical',
        description: 'Detects hardcoded API keys, tokens, passwords',
        patterns: [],
        fileExtensions: ['.ts', '.js', '.env'],
        falsePositiveMarkers: [],
        remediation: 'Use environment variables',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    metadata: {
      generatedAt: new Date().toISOString(),
      confidence: 0.5,
      targetFiles: [
        `**/*.${techStack.stack === 'nodejs' ? 'ts' : techStack.stack === 'python' ? 'py' : 'ts'}`,
      ],
    },
  };
}

/**
 * Cast-free class wrapper around the free-function helpers above so that
 * `orchestrator.ts` can compose them under a single instance field.
 * Construct via `new SkillGenerator({ completeWithRetry: this.completeWithRetry.bind(this) })`.
 */
export class SkillGenerator {
  constructor(private readonly deps: SkillGeneratorDeps) {}

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
    return generateSkillLLM(this.deps, provider, model, projectRoot, techStack, abortController);
  }

  generateFallbackSkill(techStack: TechStackInfo): GeneratedSkill {
    return generateFallbackSkill(techStack);
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
