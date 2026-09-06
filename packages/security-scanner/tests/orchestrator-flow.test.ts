import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';
import { ProviderError } from '@wrongstack/core/types';
import type { Provider, Request, Response } from '@wrongstack/core/types';
import type { ErrorHandler, RetryPolicy } from '../src/_compat-types.js';

const textResponse = (text: string): Response =>
  ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  }) as never as Response;

const fakeProvider = (complete: Provider['complete']): Provider =>
  ({
    id: 'fake',
    capabilities: {} as never,
    stream: (async function* () {})() as never,
    complete,
  }) as never as Provider;

const SKILL_JSON = JSON.stringify({
  name: 'custom-skill',
  description: 'desc',
  techStack: 'nodejs',
  patterns: [
    {
      id: 'p1',
      name: 'SQLi',
      severity: 'high',
      description: 'sql injection',
      fileExtensions: ['.ts'],
      remediation: 'parameterize',
    },
  ],
  targetFiles: ['**/*.ts'],
  scanInstructions: 'scan it',
});

const FINDINGS_JSON = JSON.stringify([
  {
    file: 'src/a.ts',
    line: 3,
    severity: 'critical',
    category: 'injection',
    title: 'Crit',
    description: 'd',
    snippet: 'evil()',
    remediation: 'fix',
  },
  { file: 'src/a.ts', severity: 'high', title: 'Hi', description: 'd', remediation: 'fix' },
  {
    file: 'src/a.ts',
    severity: 'medium',
    category: 'config',
    title: 'Med',
    description: 'd',
    remediation: 'fix',
  },
  { file: 'src/a.ts', severity: 'low', title: 'Lo', description: 'd', remediation: 'fix' },
]);

let dir: string;
let projectRoot: string;
let outputDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-orch-'));
  projectRoot = path.join(dir, 'proj');
  outputDir = path.join(dir, 'reports');
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { express: '^4' } }),
  );
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# demo readme');
  await fs.writeFile(
    path.join(projectRoot, 'src', 'a.ts'),
    `export const q = (id) => \`SELECT * WHERE id=\${id}\`;`,
  );
  // A skipped directory (node_modules) so gatherFilesRecursive exercises the skip branch.
  await fs.mkdir(path.join(projectRoot, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'node_modules', 'ignored.ts'), 'export {};');
  // Deep nesting so a 'quick' (maxDepth 2) scan trips the depth-limit return.
  await fs.mkdir(path.join(projectRoot, 'd1', 'd2', 'd3'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'd1', 'd2', 'd3', 'deep.ts'), 'export {};');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Replace the gitignore updater so tests never touch the real repo .gitignore. */
function stubGitignore(orch: SecurityScannerOrchestrator, result?: unknown) {
  const update = vi
    .fn()
    .mockResolvedValue(result ?? { added: ['security-reports/'], existing: [], errors: [] });
  (orch as never as { gitignoreUpdater: { update: typeof update } }).gitignoreUpdater = { update };
  return update;
}

describe('SecurityScannerOrchestrator.run — full flow', () => {
  it('runs detect → skill → scan → synthesize → write → gitignore', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(`Here:\n${SKILL_JSON}`))
      .mockResolvedValueOnce(textResponse(`Findings:\n${FINDINGS_JSON}`))
      .mockResolvedValueOnce(textResponse('# Security Report\nAll good.'));
    const orch = new SecurityScannerOrchestrator();
    const update = stubGitignore(orch);

    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
    });

    expect(res.generatedSkill.name).toBe('custom-skill');
    expect(res.scanResult.summary).toMatchObject({
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
      total: 4,
    });
    // sorted by severity → critical first
    expect(res.scanResult.findings[0]?.severity).toBe('critical');
    expect(res.synthesizedReport).toContain('Security Report');
    expect(res.reportPath).toContain(outputDir);
    expect(await fs.readFile(res.reportPath, 'utf-8')).toContain('Security Report');
    expect(res.gitignoreResult).toBeDefined();
    expect(update).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('skips the gitignore step when skipGitignore is set', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValueOnce(textResponse('[]'))
      .mockResolvedValueOnce(textResponse('# report'));
    const orch = new SecurityScannerOrchestrator();
    const update = stubGitignore(orch);

    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    expect(res.gitignoreResult).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a Context-shaped argument carrying provider + model', async () => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(textResponse(`${SKILL_JSON}`));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);
    // ctx with provider+model — model flows through to request.model
    const ctx = { provider: fakeProvider(complete), model: 'gpt-x' };
    await orch.run(ctx, { projectRoot, reportOptions: { outputDir }, skipGitignore: true });
    expect((complete.mock.calls[0]![0] as Request).model).toBe('gpt-x');
  });

  it('renders declared dependencies into the skill-generation prompt', async () => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(textResponse(SKILL_JSON));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);
    // Override the detector so the stack carries dependencies (the real detector returns []).
    (orch as never as { detector: { detect: (r: string) => Promise<unknown> } }).detector = {
      detect: async () => ({
        detectedStacks: [
          {
            stack: 'nodejs',
            packageManager: 'npm',
            manifestFile: 'package.json',
            dependencies: [{ name: 'express', version: '4.0.0' }],
            projectPath: '',
          },
        ],
        isMonorepo: false,
      }),
    };
    await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    expect((complete.mock.calls[0]![0] as Request).messages[0]?.content).toContain('express@4.0.0');
  });

  it('honors a quick scan depth limit and tolerates an unreadable file batch', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValueOnce(textResponse('# report'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);
    // Force the scan to target a non-existent file → readFile fails → empty batch → [].
    (orch as never as { gatherFiles: () => Promise<string[]> }).gatherFiles = async () => [
      path.join(dir, 'does-not-exist.ts'),
    ];
    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      scanOptions: { depth: 'quick' },
    });
    expect(res.scanResult.summary.total).toBe(0);
  });

  it('walks the tree honoring the quick depth limit (real gatherFiles)', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValue(textResponse('[]'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);
    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      scanOptions: { depth: 'quick' },
    });
    // deep.ts (depth 3) is excluded by the quick maxDepth, src/a.ts (depth 1) is scanned.
    expect(res.scanResult.scannedFiles).toBeGreaterThan(0);
  });

  it('throws when no tech stack is detected', async () => {
    const empty = path.join(dir, 'empty');
    await fs.mkdir(empty, { recursive: true });
    const orch = new SecurityScannerOrchestrator();
    await expect(orch.run(fakeProvider(vi.fn()), { projectRoot: empty })).rejects.toThrow(
      /No supported tech stack/,
    );
  });

  it('updates .gitignore inside projectRoot with custom report outputDir', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValue(textResponse('[]'));
    const orch = new SecurityScannerOrchestrator();
    const customReportDir = 'custom-reports-dir';
    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir: customReportDir },
    });

    const targetGitignore = path.join(projectRoot, '.gitignore');
    const content = await fs.readFile(targetGitignore, 'utf-8');
    expect(res.gitignoreResult?.added).toContain(`${customReportDir}/`);
    expect(content).toContain(`${customReportDir}/`);
    expect(content).toContain(`${customReportDir}/*`);
  });
});

describe('SecurityScannerOrchestrator — LLM failure fallbacks', () => {
  it('falls back to the basic report when synthesis fails (with findings)', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValueOnce(textResponse(FINDINGS_JSON))
      .mockRejectedValueOnce(new Error('synth boom'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    // basic report emoji branches for every severity
    expect(res.synthesizedReport).toContain('# Security Scan Report');
    expect(res.synthesizedReport).toContain('🔴');
    expect(res.synthesizedReport).toContain('🟢');
  });

  it('uses the fallback skill and empty scan when every LLM call fails', async () => {
    const complete = vi.fn<Provider['complete']>().mockRejectedValue(new Error('total outage'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    expect(res.generatedSkill.metadata.confidence).toBe(0.5); // fallback skill
    expect(res.scanResult.summary.total).toBe(0);
    expect(res.synthesizedReport).toContain('# Security Scan Report'); // basic report, no findings
  });

  it('falls back to the basic skill when the LLM returns no JSON object', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse('no json here at all'))
      .mockResolvedValueOnce(textResponse('also no array'))
      .mockResolvedValueOnce(textResponse('# report'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);
    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    expect(res.generatedSkill.metadata.confidence).toBe(0.5);
  });
});

describe('SecurityScannerOrchestrator.quickScan', () => {
  it('returns a minimal result with a not-supported error', async () => {
    const res = await new SecurityScannerOrchestrator().quickScan(projectRoot);
    expect(res.findings).toEqual([]);
    expect(res.errors[0]).toMatch(/not fully supported/);
  });

  it('throws when no stack is detected', async () => {
    const empty = path.join(dir, 'empty2');
    await fs.mkdir(empty, { recursive: true });
    await expect(new SecurityScannerOrchestrator().quickScan(empty)).rejects.toThrow(
      /No supported tech stack/,
    );
  });
});

describe('SecurityScannerOrchestrator.completeWithRetry (private)', () => {
  const req: Request = {
    model: 'm',
    system: [{ type: 'text', text: 's' }],
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 16,
  };
  const callRetry = (orch: SecurityScannerOrchestrator, provider: Provider, ac: AbortController) =>
    (
      orch as never as {
        completeWithRetry: (
          p: Provider,
          r: Request,
          a: AbortController,
          n?: number,
        ) => Promise<Response>;
      }
    ).completeWithRetry(provider, req, ac);

  it('rethrows immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = fakeProvider(vi.fn().mockRejectedValue(new Error('aborted')));
    await expect(callRetry(new SecurityScannerOrchestrator(), provider, ac)).rejects.toThrow(
      'aborted',
    );
  });

  it('rethrows a non-retryable error when no retry policy is configured', async () => {
    const provider = fakeProvider(vi.fn().mockRejectedValue(new Error('plain failure')));
    await expect(
      callRetry(new SecurityScannerOrchestrator(), provider, new AbortController()),
    ).rejects.toThrow('plain failure');
  });

  it('retries a ProviderError then succeeds, consulting the error handler', async () => {
    const retryPolicy: RetryPolicy = {
      shouldRetry: vi.fn().mockReturnValue(true),
      delayMs: vi.fn().mockReturnValue(1),
      maxAttempts: vi.fn().mockReturnValue(3),
    } as never as RetryPolicy;
    const errorHandler: ErrorHandler = {
      classify: vi.fn().mockReturnValue({ kind: 'overloaded', retryable: true }),
      recover: vi.fn(),
    } as never as ErrorHandler;
    const complete = vi
      .fn<Provider['complete']>()
      .mockRejectedValueOnce(new ProviderError('overloaded', 529, true, 'fake'))
      .mockResolvedValueOnce(textResponse('ok'));
    const orch = new SecurityScannerOrchestrator(retryPolicy, errorHandler);
    const res = await callRetry(orch, fakeProvider(complete), new AbortController());
    expect(res.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(retryPolicy.shouldRetry).toHaveBeenCalled();
    expect(errorHandler.classify).toHaveBeenCalled();
  });

  it('retries a network error (matched by regex) under a retry policy', async () => {
    const retryPolicy: RetryPolicy = {
      shouldRetry: vi.fn().mockReturnValue(true),
      delayMs: vi.fn().mockReturnValue(1),
      maxAttempts: vi.fn().mockReturnValue(2),
    } as never as RetryPolicy;
    const complete = vi
      .fn<Provider['complete']>()
      .mockRejectedValueOnce(new Error('ECONNRESET while fetching'))
      .mockResolvedValueOnce(textResponse('recovered'));
    const orch = new SecurityScannerOrchestrator(retryPolicy);
    const res = await callRetry(orch, fakeProvider(complete), new AbortController());
    expect(res.content[0]).toMatchObject({ text: 'recovered' });
  });

  it('stops retrying when the policy says not to', async () => {
    const retryPolicy: RetryPolicy = {
      shouldRetry: vi.fn().mockReturnValue(false),
      delayMs: vi.fn().mockReturnValue(1),
      maxAttempts: vi.fn().mockReturnValue(1),
    } as never as RetryPolicy;
    const provider = fakeProvider(
      vi.fn().mockRejectedValue(new ProviderError('boom', 500, true, 'fake')),
    );
    await expect(
      callRetry(new SecurityScannerOrchestrator(retryPolicy), provider, new AbortController()),
    ).rejects.toThrow('boom');
  });

  it('stops retrying when the error handler classifies the error as non-retryable', async () => {
    const retryPolicy: RetryPolicy = {
      shouldRetry: vi.fn().mockReturnValue(true),
      delayMs: vi.fn().mockReturnValue(1),
      maxAttempts: vi.fn().mockReturnValue(3),
    } as never as RetryPolicy;
    const errorHandler: ErrorHandler = {
      classify: vi.fn().mockReturnValue({ kind: 'auth', retryable: false }),
      recover: vi.fn(),
    } as never as ErrorHandler;
    const provider = fakeProvider(
      vi.fn().mockRejectedValue(new ProviderError('nope', 401, false, 'fake')),
    );
    await expect(
      callRetry(
        new SecurityScannerOrchestrator(retryPolicy, errorHandler),
        provider,
        new AbortController(),
      ),
    ).rejects.toThrow('nope');
  });
});
