/**
 * The model-written skill path's fallbacks: a description that trims to
 * nothing, a rendered skill whose frontmatter comes back without name or
 * description, and a rendered document the validator rejects (which must fall
 * back to the static skill, not surface the error). The last two cannot be
 * produced by a real render, so the skill helpers are controllable here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const skills = vi.hoisted(() => ({ emptyFrontmatter: false, rejectDocument: false }));
vi.mock('@wrongstack/core/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/skills')>();
  return {
    ...actual,
    parseSkillFrontmatter: (...args: Parameters<typeof actual.parseSkillFrontmatter>) =>
      skills.emptyFrontmatter ? {} : actual.parseSkillFrontmatter(...args),
    validateSkillDocument: (...args: Parameters<typeof actual.validateSkillDocument>) =>
      skills.rejectDocument ? ['frontmatter rejected'] : actual.validateSkillDocument(...args),
  };
});

import { shouldExcludeFile } from '../src/file-gathering.js';
import { getTargetFilesForStack } from '../src/scan-targets.js';
import { defaultSkillGenerator } from '../src/skill-generator.js';
import type { TechStackInfo } from '../src/types.js';

const stack: TechStackInfo = {
  stack: 'go',
  packageManager: 'go',
  manifestFile: 'go.mod',
  dependencies: [],
  projectPath: '.',
};

const provider = (text: string) =>
  ({
    id: 'fake',
    capabilities: {},
    complete: async () => ({
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
    }),
  }) as never;

const generate = (text: string) =>
  defaultSkillGenerator.generateSkillLLM(
    provider(text),
    'm',
    process.cwd(),
    stack,
    new AbortController(),
  );

afterEach(() => {
  skills.emptyFrontmatter = false;
  skills.rejectDocument = false;
  vi.restoreAllMocks();
});

describe('model-written skill fallbacks', () => {
  it('replaces a blank description with the stack default', async () => {
    const skill = await generate('{"name":"go-scan","description":"   ","patterns":[]}');
    expect(skill.description).toBe('Scan go projects.');
  });

  it('names the skill after the stack when its frontmatter has no name or description', async () => {
    skills.emptyFrontmatter = true;
    const skill = await generate('{"name":"go-scan","patterns":[]}');
    expect(skill.name).toBe('security-scanner-go');
    expect(skill.description).toBe('Security scanner for go');
  });

  it('falls back to the static skill when the rendered document is rejected', async () => {
    skills.rejectDocument = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const skill = await generate('{"name":"go-scan","patterns":[]}');
    expect(skill.name).toBe('security-scanner-go');
    expect(skill.metadata.confidence).not.toBe(0.85); // not the model-written path
  });

  it('preserves .npmrc in shouldExcludeFile and nodejs target files, and normalizes non-array LLM patterns to [] (F854)', async () => {
    expect(shouldExcludeFile('.npmrc', '.npmrc', [], true)).toBe(false);
    expect(getTargetFilesForStack({ stack: 'nodejs' })).toContain('**/.npmrc');
    const skill = await generate('{"name":"go-scan","description":"ok","patterns":"invalid"}');
    expect(skill.patterns).toEqual([]);
  });

  it('drops non-object LLM pattern entries, so a null cannot crash the batch prompt (F1286)', async () => {
    const pattern = {
      id: 'p',
      name: 'P',
      severity: 'high',
      description: 'd',
      fileExtensions: ['.go'],
      remediation: 'r',
    };
    const skill = await generate(
      JSON.stringify({
        name: 'go-scan',
        description: 'ok',
        patterns: [null, pattern, 'text', ['nested']],
      }),
    );
    expect(skill.metadata.confidence).toBe(0.85); // still the model-written path
    expect(skill.patterns).toEqual([pattern]);
  });
});
