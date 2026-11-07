/**
 * The batch scanner turns whatever JSON the model returns into `Finding`s. A
 * model omits fields, invents severities and names files it was never shown;
 * each of those has a fixed fallback, and a finding for an unscanned file is
 * dropped rather than reported against a path nobody asked about.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchScanner } from '../src/batch-scanner.js';
import { parseNodeDependencies } from '../src/manifest-parser.js';
import { gatherProjectInfo } from '../src/skill-generator.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function project(files: Record<string, string>): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-normalize-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.writeFile(path.join(root, rel), body);
  }
  return root;
}

function scan(
  dir: string,
  complete: (...args: unknown[]) => Promise<unknown>,
  overrides: { llmBatchSize?: number; abortController?: AbortController } = {},
) {
  return new BatchScanner().runBatchScan({
    provider: { complete } as never,
    model: 'm',
    projectRoot: dir,
    skill: { patterns: [], metadata: { targetFiles: ['**/*.ts'] } } as never,
    techStack: { stack: 'nodejs' } as never,
    depth: 'quick',
    llmBatchSize: overrides.llmBatchSize ?? 10,
    fileConcurrency: 10,
    abortController: overrides.abortController ?? new AbortController(),
  });
}

const reply = (items: unknown[]) => async () => ({
  content: [{ type: 'text', text: JSON.stringify(items) }],
});

describe('batch scanner finding normalization', () => {
  it('fills defaults for a finding with missing or invalid fields', async () => {
    const dir = await project({ 'app.ts': 'eval(input);' });
    const result = await scan(
      dir,
      reply([{ file: 'app.ts', severity: 42, title: 'Eval', line: 3 }]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: 'app.ts',
        severity: 'medium',
        category: 'injection',
        title: 'Eval',
        description: '',
        line: 3,
        remediation: 'Review and remediate this finding.',
      }),
    ]);
  });

  it('keeps a valid severity, lower-casing it, and the model-written text', async () => {
    const dir = await project({ 'app.ts': 'eval(input);' });
    const result = await scan(
      dir,
      reply([
        {
          file: path.join(dir, 'app.ts'),
          severity: 'HIGH',
          category: 'secrets',
          title: 'Key',
          description: 'hardcoded key',
          remediation: 'rotate it',
        },
      ]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: 'app.ts',
        severity: 'high',
        category: 'secrets',
        description: 'hardcoded key',
        remediation: 'rotate it',
      }),
    ]);
  });

  it('drops a finding for a file that was not in the batch', async () => {
    const dir = await project({ 'app.ts': 'eval(input);' });
    const result = await scan(
      dir,
      reply([
        { file: 'elsewhere/secret.ts', severity: 'critical', title: 'Invented' },
        { file: 'app.ts', severity: 'low', title: 'Real' },
      ]),
    );
    expect(result.findings.map((f) => f.title)).toEqual(['Real']);
  });

  it('stops after the completed batch during which the scan was aborted and keeps its findings', async () => {
    const dir = await project({ 'a.ts': 'eval(a);', 'b.ts': 'eval(b);' });
    const abortController = new AbortController();
    const complete = vi.fn(async () => {
      abortController.abort();
      return { content: [{ type: 'text', text: '[{"file":"a.ts","title":"A"}]' }] };
    });
    const result = await scan(dir, complete, { llmBatchSize: 1, abortController });
    expect(complete).toHaveBeenCalledOnce();
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: 'a.ts',
        title: 'A',
      }),
    ]);
    expect(result.scannedFiles).toBe(1);
  });

  it('normalizes ./ prefixes, whitespace, and echoed === file === section headers (F35)', async () => {
    const dir = await project({ 'app.ts': 'eval(input);' });
    const result = await scan(
      dir,
      reply([
        { file: './app.ts', severity: 'high', title: 'DotSlash' },
        { file: '  === app.ts ===  ', severity: 'critical', title: 'HeaderEcho' },
      ]),
    );
    expect(result.findings.map((f) => ({ file: f.file, title: f.title }))).toEqual([
      { file: 'app.ts', title: 'HeaderEcho' },
      { file: 'app.ts', title: 'DotSlash' },
    ]);
  });

  it('normalizes leading-slash repo paths, :line suffixes, and unique batch basenames (F31)', async () => {
    const dir = await project({ 'app.ts': 'eval(input);' });
    const result = await scan(
      dir,
      reply([
        { file: '/app.ts', severity: 'critical', title: 'LeadingSlash' },
        { file: 'app.ts:7', severity: 'high', title: 'LineSuffix' },
      ]),
    );
    expect(result.findings.map((f) => ({ file: f.file, title: f.title, line: f.line }))).toEqual([
      { file: 'app.ts', title: 'LeadingSlash', line: undefined },
      { file: 'app.ts', title: 'LineSuffix', line: 7 },
    ]);
  });
});

describe('scan inputs at the project boundary', () => {
  it('reads dependencies from a package.json written with a UTF-8 BOM', () => {
    const deps = parseNodeDependencies('﻿{"dependencies":{"express":"^5.0.0"}}');
    expect(deps).toEqual([expect.objectContaining({ name: 'express', version: '^5.0.0' })]);
  });

  it('returns no project info for a root that does not resolve', async () => {
    const missing = path.join(os.tmpdir(), `batch-normalize-missing-${process.pid}-${Date.now()}`);
    await expect(gatherProjectInfo(missing, { stack: 'nodejs' } as never)).resolves.toBe('');
  });
});
