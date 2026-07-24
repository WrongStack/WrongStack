import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Provider, Request, Response } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';

const response = (text: string) =>
  ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 0, output: 0 },
  }) as never as Response;

const provider = (text: string): Provider =>
  ({
    id: 'test',
    capabilities: {},
    async complete() {
      return response(text);
    },
  }) as never;

const stack = (name: string) =>
  ({
    stack: name,
    packageManager: 'unknown',
    manifestFile: '',
    dependencies: [],
    projectPath: '',
  }) as never;

const skill = {
  name: 'test',
  description: 'test',
  version: '1',
  techStack: 'python',
  content: { type: 'skill', content: '' },
  patterns: [],
  metadata: { generatedAt: '', confidence: 1, targetFiles: [] },
} as never;

type Internals = {
  completeWithRetry(
    provider: Provider,
    request: Request,
    controller: AbortController,
  ): Promise<Response>;
  generateSkillLLM(
    provider: Provider,
    model: string | undefined,
    root: string,
    stack: never,
    controller: AbortController,
  ): Promise<{ name: string; description: string; patterns: unknown[]; metadata: { targetFiles: string[] } }>;
  scanWithLLM(
    provider: Provider,
    model: string | undefined,
    root: string,
    skill: never,
    stack: never,
    options: never,
    controller: AbortController,
  ): Promise<unknown>;
  scanFileBatchLLM(
    provider: Provider,
    model: string | undefined,
    root: string,
    files: string[],
    skill: never,
    stack: never,
    concurrency: number,
    controller: AbortController,
  ): Promise<Array<{ file: string; category: string }>>;
  gatherFiles(root: string, patterns: string[], depth: 'quick' | 'standard' | 'deep'): Promise<string[]>;
  generateFallbackSkill(stack: never): { metadata: { targetFiles: string[] } };
  writeReport(content: string, options?: never): Promise<string>;
};

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
    const orchestrator = new SecurityScannerOrchestrator(retryPolicy as never) as never as Internals;
    const failing = {
      complete: vi.fn().mockRejectedValue('network string failure'),
    } as never;
    await expect(
      orchestrator.completeWithRetry(
        failing,
        { model: 'm', messages: [] },
        new AbortController(),
      ),
    ).rejects.toBe('network string failure');
  });

  it('generates Python defaults and falls back after balanced invalid JSON', async () => {
    const orchestrator = new SecurityScannerOrchestrator() as never as Internals;
    const generated = await orchestrator.generateSkillLLM(
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

    const fallback = await orchestrator.generateSkillLLM(
      provider('{invalid}'),
      'm',
      root,
      stack('go'),
      new AbortController(),
    );
    expect(fallback.name).toBe('security-scanner-go');
  });

  it('handles non-finite scan controls and all file-gathering depth fallbacks', async () => {
    const orchestrator = new SecurityScannerOrchestrator() as never as Internals;
    vi.spyOn(orchestrator, 'gatherFiles').mockResolvedValueOnce([]);
    await orchestrator.scanWithLLM(
      provider('[]'),
      undefined,
      root,
      skill,
      stack('python'),
      {
        projectRoot: root,
        scanOptions: { llmBatchSize: Number.NaN, fileConcurrency: Number.POSITIVE_INFINITY },
      } as never,
      new AbortController(),
    );

    expect(await orchestrator.gatherFiles(root, ['**/*'], 'quick')).toContain(
      path.join(root, 'source.ts'),
    );
    expect(await orchestrator.gatherFiles(root, ['**/*'], 'deep')).toContain(
      path.join(root, 'source.ts'),
    );
  });

  it('normalizes absolute findings and rejects invalid balanced arrays safely', async () => {
    const orchestrator = new SecurityScannerOrchestrator() as never as Internals;
    const absolute = path.join(root, 'source.ts');
    const findings = await orchestrator.scanFileBatchLLM(
      provider(
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
      undefined,
      root,
      [absolute],
      skill,
      stack('python'),
      1,
      new AbortController(),
    );
    expect(findings[0]).toMatchObject({ file: 'source.ts', category: 'secrets' });

    await expect(
      orchestrator.scanFileBatchLLM(
        provider('[invalid]'),
        'm',
        root,
        [absolute],
        skill,
        stack('python'),
        1,
        new AbortController(),
      ),
    ).resolves.toEqual([]);
  });

  it('uses report defaults and fallback extensions for Python and other stacks', async () => {
    const orchestrator = new SecurityScannerOrchestrator() as never as Internals;
    expect(await orchestrator.writeReport('# report')).toMatch(/security-reports/);
    expect(orchestrator.generateFallbackSkill(stack('python')).metadata.targetFiles).toEqual([
      '**/*.py',
    ]);
    expect(orchestrator.generateFallbackSkill(stack('go')).metadata.targetFiles).toEqual([
      '**/*.ts',
    ]);
  });
});
