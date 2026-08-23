import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Provider, Request, Response } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';
import { defaultSkillGenerator, generateFallbackSkill } from '../src/skill-generator.js';
import { BatchScanner } from '../src/batch-scanner.js';
import { writeReport } from '../src/report-writer.js';
import { gatherFiles } from '../src/file-gathering.js';
import type { TechStackInfo } from '../src/types.js';

const response = (text: string) =>
  ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
  }) as never as Response;

const provider = (text: string): Provider =>
  ({
    id: 'test',
    capabilities: {} as never,
    stream: (async function* () {})() as never,
    async complete() {
      return response(text);
    },
  }) as never as Provider;

const stack = (name: string): TechStackInfo =>
  ({
    stack: name,
    packageManager: 'unknown',
    manifestFile: '',
    dependencies: [],
    projectPath: '',
  }) as never as TechStackInfo;

const skill = {
  name: 'test',
  description: 'test',
  version: '1',
  techStack: 'python',
  content: { type: 'skill', content: '' },
  patterns: [],
  metadata: { generatedAt: '', confidence: 1, targetFiles: [] },
} as never;

let root: string;
let previousCwd: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-coverage-'));
  previousCwd = process.cwd();
  process.chdir(root);
  await fs.writeFile(path.join(root, 'source.ts'), 'const value = 1;');
});

afterEach(async () => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('orchestrator branch completion', () => {
  it('normalizes non-Error provider failures before consulting retry policy', async () => {
    const retryPolicy = { shouldRetry: vi.fn().mockReturnValue(false) };
    const orchestrator = new SecurityScannerOrchestrator(retryPolicy as never);
    const failing = {
      id: 'test',
      capabilities: {} as never,
      stream: (async function* () {})() as never,
      complete: vi.fn().mockRejectedValue('network string failure'),
    } as never as Provider;
    await expect(
      (orchestrator as unknown as { completeWithRetry: (p: Provider, r: Request, c: AbortController) => Promise<Response> }).completeWithRetry(
        failing,
        { model: 'm', messages: [] },
        new AbortController(),
      ),
    ).rejects.toBe('network string failure');
  });

  it('generates Python defaults and falls back after balanced invalid JSON', async () => {
    const generated = await defaultSkillGenerator.generateSkillLLM(
      provider('{}'),
      undefined,
      root,
      stack('python'),
      new AbortController(),
    );
    expect(generated).toMatchObject({
      name: 'security-scanner-python',
      description: 'Security scanner for python',
      patterns: [],
      metadata: { targetFiles: [] },
    });

    const fallback = await defaultSkillGenerator.generateSkillLLM(
      provider('{invalid}'),
      'm',
      root,
      stack('go'),
      new AbortController(),
    );
    expect(fallback.name).toBe('security-scanner-go');
  });

  it('handles non-finite scan controls and all file-gathering depth fallbacks', async () => {
    const batchScanner = new BatchScanner();
    const result = await batchScanner.runBatchScan({
      provider: provider('[]'),
      model: undefined,
      projectRoot: root,
      skill,
      techStack: stack('python'),
      depth: 'quick',
      llmBatchSize: Number.NaN,
      fileConcurrency: Number.POSITIVE_INFINITY,
      abortController: new AbortController(),
    });
    expect(result.scannedFiles).toBeGreaterThanOrEqual(0);

    const quickFiles = await gatherFiles({
      root,
      extensions: ['.ts'],
      maxDepth: 2,
      excludePatterns: [],
    });
    expect(quickFiles).toContain(path.join(root, 'source.ts'));

    const deepFiles = await gatherFiles({
      root,
      extensions: ['.ts'],
      maxDepth: 20,
      excludePatterns: [],
    });
    expect(deepFiles).toContain(path.join(root, 'source.ts'));
  });

  it('normalizes absolute findings and rejects invalid balanced arrays safely', async () => {
    const batchScanner = new BatchScanner();
    const absolute = path.join(root, 'source.ts');
    const scanBatch = (batchScanner as unknown as {
      scanFileBatchLLM(opts: {
        provider: Provider;
        model: string | undefined;
        projectRoot: string;
        files: string[];
        skill: typeof skill;
        techStack: TechStackInfo;
        fileConcurrency: number;
        abortController: AbortController;
        retryPolicy?: undefined;
        errorHandler?: undefined;
      }): Promise<Array<{ file: string; category: string }>>;
    }).scanFileBatchLLM.bind(batchScanner);

    const findings = await scanBatch({
      provider: provider(
        JSON.stringify([
          {
            file: absolute,
            severity: 'high',
            category: 'secrets',
            title: 'Issue',
            description: 'Description',
            remediation: 'Fix',
          },
        ]),
      ),
      model: undefined,
      projectRoot: root,
      files: [absolute],
      skill,
      techStack: stack('python'),
      fileConcurrency: 1,
      abortController: new AbortController(),
    });
    expect(findings[0]).toMatchObject({ file: 'source.ts', category: 'secrets' });

    await expect(
      scanBatch({
        provider: provider('[invalid]'),
        model: 'm',
        projectRoot: root,
        files: [absolute],
        skill,
        techStack: stack('python'),
        fileConcurrency: 1,
        abortController: new AbortController(),
      }),
    ).resolves.toEqual([]);
  });

  it('uses report defaults and fallback extensions for Python and other stacks', async () => {
    expect(await writeReport('# report', root)).toMatch(/security-reports/);
    expect(generateFallbackSkill(stack('python')).metadata.targetFiles).toEqual([
      '**/*.py',
      '**/requirements*.txt',
      '**/setup.py',
      '**/pyproject.toml',
      '**/.env*',
    ]);
    expect(generateFallbackSkill(stack('go')).metadata.targetFiles).toEqual([
      '**/*.go',
      '**/go.mod',
      '**/go.sum',
    ]);
  });
});
