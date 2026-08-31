import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Provider, Request } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SecurityScanner } from '../src/scanner.js';
import type { GeneratedSkill } from '../src/skill-generator.js';
import type { SecurityPattern, TechStackInfo } from '../src/types.js';

const temporaryDirectories: string[] = [];
const stack: TechStackInfo = {
  stack: 'nodejs',
  packageManager: 'npm',
  manifestFile: 'package.json',
  dependencies: [],
  projectPath: '',
};

function skill(patterns: SecurityPattern[], confidence = 0.9): GeneratedSkill {
  return {
    name: 'test',
    description: 'test',
    version: '1.0.0',
    techStack: 'nodejs',
    content: { type: 'skill', content: '' },
    patterns,
    metadata: { generatedAt: new Date().toISOString(), confidence, targetFiles: ['**/*.ts'] },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('SecurityScanner refactor contracts', () => {
  it('prefers an explicit category for ambiguous IDs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-category-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'value.ts'), 'danger\n');
    const pattern: SecurityPattern = {
      id: 'secret-config-injection',
      name: 'Ambiguous',
      severity: 'high',
      description: 'ambiguous ID',
      patterns: [/danger/g],
      fileExtensions: ['.ts'],
      falsePositiveMarkers: [],
      remediation: 'fix',
      category: 'config',
    };

    const result = await new SecurityScanner({
      includeSecrets: false,
      includeInjection: false,
      includeConfig: true,
    }).scan(root, skill([pattern]), stack);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('config');
  });

  it('honors includeDependencies=false', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-dependency-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'value.ts'), 'vulnerable dependency\n');
    const pattern: SecurityPattern = {
      id: 'dependency-vulnerability',
      name: 'Dependency',
      severity: 'high',
      description: 'dependency issue',
      patterns: [/vulnerable dependency/g],
      fileExtensions: ['.ts'],
      falsePositiveMarkers: [],
      remediation: 'upgrade',
      category: 'dependency',
    };
    const result = await new SecurityScanner({ includeDependencies: false }).scan(
      root,
      skill([pattern]),
      stack,
    );
    expect(result.findings).toEqual([]);
  });

  it('creates normalized project-relative IDs and context-aware confidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-path-'));
    temporaryDirectories.push(root);
    const directory = path.join(root, 'tests');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'value.test.ts'), 'danger\n');
    const pattern: SecurityPattern = {
      id: 'specific-danger',
      name: 'Danger',
      severity: 'high',
      description: 'danger',
      patterns: [/danger/g],
      fileExtensions: ['.ts'],
      falsePositiveMarkers: [],
      remediation: 'fix',
      category: 'filesystem',
      confidence: 'high',
    };
    const result = await new SecurityScanner({ fileConcurrency: 2 }).scan(
      root,
      skill([pattern]),
      stack,
    );
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        id: 'specific-danger-tests/value.test.ts-1',
        file: 'tests/value.test.ts',
        confidence: 'medium',
      }),
    );
  });

  it('gathers and scans wildcard targetFiles such as **/.env* in BatchScanner', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-scanner-wildcard-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, '.env'), 'SECRET_KEY="abc123456789"\n');
    await fs.writeFile(path.join(root, 'index.ts'), 'export const x = 1;\n');

    const testSkill: GeneratedSkill = {
      name: 'test',
      description: 'test',
      version: '1.0.0',
      techStack: 'nodejs',
      content: { type: 'skill', content: '' },
      patterns: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        confidence: 1.0,
        targetFiles: ['**/*.ts', '**/.env*'],
      },
    };

    const passedFiles: string[] = [];
    const { BatchScanner } = await import('../src/batch-scanner.js');
    const scanner = new BatchScanner();
    await scanner.runBatchScan({
      provider: {
        id: 'mock',
        capabilities: {} as never,
        stream: (async function* () {})() as never,
        complete: async (req: Request) => {
          const text = req.messages[0]?.content as string;
          const matches = text.match(/===\s+([^\s=]+)\s+===/g) ?? [];
          for (const m of matches) {
            passedFiles.push(m.replace(/===\s+/, '').replace(/\s+===/, ''));
          }
          return {
            content: [{ type: 'text', text: '[]' }],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: 'test',
          };
        },
      } as never as Provider,
      model: 'test',
      projectRoot: root,
      skill: testSkill,
      techStack: stack,
      depth: 'standard',
      llmBatchSize: 10,
      fileConcurrency: 5,
      abortController: new AbortController(),
    });

    expect(passedFiles).toContain('.env');
    expect(passedFiles).toContain('index.ts');
  });
});
