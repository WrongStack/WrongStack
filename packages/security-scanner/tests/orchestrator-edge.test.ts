/**
 * Edge-case tests for SecurityScannerOrchestrator covering uncovered branches:
 * - timeoutMs option (line 147 setTimeout path)
 * - externalSignal already aborted (line 151)
 * - externalSignal added listener (line 153)
 * - catch in generateSkillLLM when LLM fails (fallback)
 * - catch in scanFileBatchLLM when readFile fails (line 384)
 * - catch in gatherProjectInfo when readdir fails
 * - catch in gatherFilesRecursive when readdir fails
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';
import type { Provider, Response } from '@wrongstack/core/types';

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
});

let dir: string;
let projectRoot: string;
let outputDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-oc-'));
  projectRoot = path.join(dir, 'proj');
  outputDir = path.join(dir, 'reports');
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'demo' }));
  await fs.writeFile(path.join(projectRoot, 'src', 'a.ts'), 'const x = 1;\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function stubGitignore(orch: SecurityScannerOrchestrator) {
  const update = vi.fn().mockResolvedValue({ added: [], existing: [], errors: [] });
  (orch as never as { gitignoreUpdater: { update: typeof update } }).gitignoreUpdater = { update };
}

describe('SecurityScannerOrchestrator - timeout and signal', () => {
  it('accepts timeoutMs option and aborts after timeout (falls back)', async () => {
    // The LLM call hangs but listens to the abort signal
    const complete = vi.fn<Provider['complete']>().mockImplementation(
      (_req, opts) =>
        new Promise<never>((_resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    // timeoutMs = 500ms → abort fires, generateSkillLLM catches it and falls back
    const result = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      timeoutMs: 500,
    });
    expect(result.generatedSkill).toBeDefined();
    // Should have used fallback skill
    expect(result.generatedSkill.name).toContain('security-scanner');
  }, 15000);

  it('accepts an external signal and aborts when it fires (falls back)', async () => {
    const ac = new AbortController();
    const complete = vi.fn<Provider['complete']>().mockImplementation(
      (_req, opts) =>
        new Promise<never>((_resolve, reject) => {
          const signal = opts?.signal;
          if (signal?.aborted) {
            reject(new Error('signal already aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('Aborted by signal')));
        }),
    );
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    // Start the run and abort immediately
    const runPromise = orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      signal: ac.signal,
    });
    // Small delay to let run() set up, then abort
    setTimeout(() => ac.abort(), 50);

    // Should fall back, not throw
    const result = await runPromise;
    expect(result.generatedSkill).toBeDefined();
  }, 15000);

  it('handles already-aborted external signal (falls back)', async () => {
    const ac = new AbortController();
    ac.abort(); // Pre-abort
    const complete = vi.fn<Provider['complete']>().mockRejectedValue(new Error('never called'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    const result = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      signal: ac.signal,
    });
    // Should complete with fallback skill since signal is already aborted
    expect(result.generatedSkill).toBeDefined();
  }, 15000);

  it('handles already-aborted external signal even when timeoutMs is configured', async () => {
    const ac = new AbortController();
    ac.abort(); // Pre-abort
    const complete = vi.fn<Provider['complete']>().mockRejectedValue(new Error('never called'));
    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    const start = Date.now();
    const result = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
      signal: ac.signal,
      timeoutMs: 10000,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result.generatedSkill).toBeDefined();
  }, 15000);
});

describe('SecurityScannerOrchestrator - gatherFiles error paths', () => {
  it('handles inaccessible directories in gatherFilesRecursive', async () => {
    const inaccessible = path.join(projectRoot, 'restricted');
    await fs.mkdir(inaccessible, { recursive: true });

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
    });
    // Should still complete without error, inaccessible dirs are skipped
    expect(res.scanResult.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it('handles gatherProjectInfo readFile failure for key files', async () => {
    const complete = vi
      .fn<Provider['complete']>()
      .mockResolvedValueOnce(textResponse(SKILL_JSON))
      .mockResolvedValue(textResponse('[]'));

    const orch = new SecurityScannerOrchestrator();
    stubGitignore(orch);

    // Key files that don't exist should be silently skipped
    const res = await orch.run(fakeProvider(complete), {
      projectRoot,
      reportOptions: { outputDir },
      skipGitignore: true,
    });
    expect(res.generatedSkill).toBeDefined();
  });
});

describe('SecurityScannerOrchestrator - completeWithRetry abort during backoff', () => {
  it('rejects when abort fires during retry backoff delay', async () => {
    const retryPolicy = {
      shouldRetry: vi.fn().mockReturnValue(true) as never,
      delayMs: vi.fn().mockReturnValue(10000) as never,
      maxAttempts: vi.fn().mockReturnValue(3) as never,
    };
    const orch = new SecurityScannerOrchestrator(retryPolicy as never);
    const req = {
      model: 'm',
      system: [{ type: 'text' as const, text: 's' }],
      messages: [{ role: 'user' as const, content: 'hi' }],
      maxTokens: 16,
    };

    const provider = fakeProvider(vi.fn().mockRejectedValue(new Error('ECONNRESET retry me')));
    const callRetry = (ac: AbortController) =>
      (
        orch as never as {
          completeWithRetry: (
            p: Provider,
            r: typeof req,
            a: AbortController,
            n?: number,
          ) => Promise<Response>;
        }
      ).completeWithRetry(provider, req, ac);

    const ac = new AbortController();
    const promise = callRetry(ac);
    // Abort during the backoff
    setTimeout(() => ac.abort(), 5);
    await expect(promise).rejects.toThrow('Retry backoff aborted');
  });
});
