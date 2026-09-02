import { beforeEach, describe, expect, it } from 'vitest';
import { SkillGenerator } from '../src/skill-generator.js';
import type { TechStackInfo } from '../src/types.js';

describe('SkillGenerator', () => {
  let generator: SkillGenerator;

  beforeEach(() => {
    generator = new SkillGenerator();
  });

  const createMockTechStack = (stack: TechStackInfo['stack']): TechStackInfo => ({
    stack,
    packageManager: stack === 'nodejs' ? 'npm' : stack === 'python' ? 'pip' : 'cargo',
    manifestFile: stack === 'nodejs' ? 'package.json' : stack === 'rust' ? 'Cargo.toml' : 'go.mod',
    dependencies: [
      { name: 'lodash', version: '4.17.20', isDev: false },
      { name: 'express', version: '4.18.0', isDev: false },
    ],
    projectPath: '/test/project',
  });

  describe('Node.js', () => {
    it('generates skill with Node.js patterns', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-nodejs');
      expect(skill.techStack).toBe('nodejs');
      expect(skill.content.type).toBe('skill');
      expect(skill.patterns.length).toBeGreaterThan(0);
      expect(skill.metadata.confidence).toBeGreaterThan(0.7);
    });

    it('includes npm-specific patterns', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      const npmPattern = skill.patterns.find((p) => p.id === 'npmrc-credentials');
      expect(npmPattern).toBeDefined();
      expect(npmPattern?.severity).toBe('high');
    });
  });

  describe('Python', () => {
    it('generates skill with Python patterns', () => {
      const techStack = createMockTechStack('python');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-python');
      expect(skill.techStack).toBe('python');

      const pythonPattern = skill.patterns.find((p) => p.id === 'python-secret-env');
      expect(pythonPattern).toBeDefined();
    });

    it('includes SQL injection pattern', () => {
      const techStack = createMockTechStack('python');
      const skill = generator.generate(techStack);

      const sqlPattern = skill.patterns.find((p) => p.id === 'python-sql-injection');
      expect(sqlPattern).toBeDefined();
      expect(sqlPattern?.severity).toBe('critical');
    });
  });

  describe('Go', () => {
    it('generates skill with Go patterns', () => {
      const techStack = createMockTechStack('go');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-go');
      expect(skill.techStack).toBe('go');
    });
  });

  describe('Rust', () => {
    it('generates skill with Rust patterns', () => {
      const techStack = createMockTechStack('rust');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-rust');
      expect(skill.techStack).toBe('rust');
    });
  });

  describe('Java', () => {
    it('generates skill with Java patterns', () => {
      const techStack = createMockTechStack('java');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-java');
      expect(skill.techStack).toBe('java');
    });
  });

  describe('.NET', () => {
    it('generates skill with .NET patterns', () => {
      const techStack = createMockTechStack('dotnet');
      const skill = generator.generate(techStack);

      expect(skill.name).toBe('security-scanner-dotnet');
      expect(skill.techStack).toBe('dotnet');
    });
  });

  describe('options', () => {
    it('respects includeSecrets option', () => {
      const techStack = createMockTechStack('nodejs');
      const generatorWithSecrets = new SkillGenerator({ includeSecrets: true });
      const generatorWithoutSecrets = new SkillGenerator({ includeSecrets: false });

      const withSecrets = generatorWithSecrets.generate(techStack);
      const withoutSecrets = generatorWithoutSecrets.generate(techStack);

      expect(withSecrets.patterns.some((p) => p.id === 'hardcoded-secrets')).toBe(true);
      expect(withoutSecrets.patterns.some((p) => p.id === 'hardcoded-secrets')).toBe(false);
    });

    it('respects severityThreshold option', () => {
      const techStack = createMockTechStack('nodejs');
      const generatorHigh = new SkillGenerator({ severityThreshold: 'high' });

      const skill = generatorHigh.generate(techStack);
      expect(skill.patterns.every((p) => ['critical', 'high'].includes(p.severity))).toBe(true);
    });
  });

  describe('skill content', () => {
    it('generates valid skill markdown content', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.content.content).toContain('# Security Scanner');
      expect(skill.content.content).toContain('nodejs');
      expect(skill.content.content).toContain('## Severity Levels');
    });

    it('includes remediation information', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.content.content).toContain('Remediation');
      expect(skill.content.content).toContain('environment variables');
    });
  });

  describe('confidence calculation', () => {
    it('increases confidence with dependencies', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.metadata.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('marks generated timestamp', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.metadata.generatedAt).toBeDefined();
      expect(new Date(skill.metadata.generatedAt).toISOString()).toBe(skill.metadata.generatedAt);
    });
  });

  describe('target files', () => {
    it('returns correct target files for Node.js', () => {
      const techStack = createMockTechStack('nodejs');
      const skill = generator.generate(techStack);

      expect(skill.metadata.targetFiles).toContain('**/*.ts');
      expect(skill.metadata.targetFiles).toContain('**/*.js');
      expect(skill.metadata.targetFiles).toContain('**/package.json');
    });

    it('returns correct target files for Python', () => {
      const techStack = createMockTechStack('python');
      const skill = generator.generate(techStack);

      expect(skill.metadata.targetFiles).toContain('**/*.py');
      expect(skill.metadata.targetFiles).toContain('**/requirements*.txt');
    });

    it('returns correct target files for Rust', () => {
      const techStack = createMockTechStack('rust');
      const skill = generator.generate(techStack);

      expect(skill.metadata.targetFiles).toContain('**/*.rs');
      expect(skill.metadata.targetFiles).toContain('**/Cargo.toml');
    });
  });
});
