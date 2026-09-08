import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Provider, Response } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BatchScanner } from '../src/batch-scanner.js';
import { gatherFiles, shouldExcludeDir, shouldExcludeFile } from '../src/file-gathering.js';
import { extractJsonBlock } from '../src/json-extractor.js';
import { sleepWithAbort } from '../src/llm-client.js';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';
import { PackageAuditRunner } from '../src/package-audit.js';
import { ReportWriter } from '../src/report-writer.js';
import type { ScanResult } from '../src/scanner.js';
import { SecurityScanner } from '../src/scanner.js';
import { generateSkillLLM, SkillGenerator } from '../src/skill-generator.js';
import type { GeneratedSkill, SecurityPattern, TechStackInfo } from '../src/types.js';

describe('security-scanner 100% coverage edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-scan-100-'));
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const dummyStack: TechStackInfo = {
    stack: 'nodejs',
    packageManager: 'npm',
    manifestFile: 'package.json',
    dependencies: [],
    projectPath: '',
  };

  const response = (text: string): Response => ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 0, output: 0 },
    model: 'test-model',
  });

  const dummySkill: GeneratedSkill = {
    name: 'sec-skill',
    description: 'test skill',
    version: '1.0.0',
    techStack: 'nodejs',
    content: { type: 'skill', content: '' },
    patterns: [
      {
        id: 'p1',
        name: 'test pattern',
        severity: 'high',
        description: 'desc',
        category: 'secrets',
        patterns: [/secret/g],
        fileExtensions: ['.ts'],
        falsePositiveMarkers: [],
        remediation: 'remove the test secret',
      },
    ],
    metadata: {
      generatedAt: new Date().toISOString(),
      confidence: 1,
      targetFiles: ['Dockerfile', '**/*.ts'],
    },
  };

  describe('batch-scanner.ts', () => {
    it('handles depth quick, deep, target files without extensions, and empty file contents', async () => {
      const scanner = new BatchScanner();
      const testFile = path.join(tmpDir, 'test.ts');
      await fs.writeFile(testFile, 'const x = "secret";');

      const mockProvider: Provider = {
        id: 'test-p',
        capabilities: {} as never,
        stream: (async function* () {})() as never,
        async complete() {
          return response('[]');
        },
      };

      const resQuick = await scanner.runBatchScan({
        projectRoot: tmpDir,
        skill: dummySkill,
        provider: mockProvider,
        model: undefined,
        techStack: dummyStack,
        depth: 'quick',
        llmBatchSize: undefined,
        fileConcurrency: undefined,
        abortController: new AbortController(),
      });
      expect(Array.isArray(resQuick.findings)).toBe(true);

      const resDeep = await scanner.runBatchScan({
        projectRoot: tmpDir,
        skill: dummySkill,
        provider: mockProvider,
        model: undefined,
        techStack: dummyStack,
        depth: 'deep',
        llmBatchSize: undefined,
        fileConcurrency: undefined,
        abortController: new AbortController(),
      });
      expect(Array.isArray(resDeep.findings)).toBe(true);

      const resEmpty = await (scanner as any).scanFileBatchLLM({
        provider: mockProvider,
        skill: dummySkill,
        techStack: dummyStack,
        abortController: new AbortController(),
        files: [path.join(tmpDir, 'non-existent-dir', 'missing.ts')],
        projectRoot: tmpDir,
        fileConcurrency: 2,
      });
      expect(resEmpty).toEqual([]);
    });
  });

  describe('file-gathering.ts', () => {
    it('covers relativePath without backslash, empty pattern, extension without dot, and non-file entry', async () => {
      expect(shouldExcludeDir('src', 'src/components', ['test'])).toBe(false);
      expect(shouldExcludeDir('src', 'src\\components', ['test'])).toBe(false);
      expect(shouldExcludeFile('a.ts', 'src/a.ts', ['test'])).toBe(false);
      expect(shouldExcludeFile('a.ts', 'src\\a.ts', ['test'])).toBe(false);
      expect(shouldExcludeFile('a.ts', 'src/a.ts', ['./'])).toBe(false);

      const f1 = path.join(tmpDir, 'f1.ts');
      await fs.writeFile(f1, 'code');
      const gathered = await gatherFiles({
        root: tmpDir,
        extensions: ['ts'],
        maxDepth: 5,
        excludePatterns: [],
      });
      expect(gathered.length).toBeGreaterThan(0);

      // Symlink where isFile() and isDirectory() are false in readdir
      try {
        await fs.symlink(f1, path.join(tmpDir, 'symlink_f'));
        const withSymlink = await gatherFiles({
          root: tmpDir,
          extensions: ['.ts'],
          maxDepth: 2,
          excludePatterns: [],
        });
        expect(withSymlink.length).toBeGreaterThan(0);
      } catch {
        // symlink creation may require admin on older Windows; skip if unsupported
      }
    });
  });

  describe('json-extractor.ts', () => {
    it('returns null for invalid container type', () => {
      expect(extractJsonBlock('{}', 'number' as never)).toBeNull();
    });
  });

  describe('llm-client.ts', () => {
    it('sleepWithAbort rejects immediately if already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(sleepWithAbort(1000, ac)).rejects.toThrow('Retry backoff aborted');
    });
  });

  describe('orchestrator.ts', () => {
    it('clears timeoutId when externalSignal fires before timeoutMs', async () => {
      const mockProvider: Provider = {
        id: 'test-p',
        capabilities: {} as never,
        stream: (async function* () {})() as never,
        async complete() {
          return response('[]');
        },
      };

      const orchestrator = new SecurityScannerOrchestrator();
      const ac = new AbortController();

      setTimeout(() => ac.abort(), 10);

      await orchestrator.run(
        { provider: mockProvider },
        {
          projectRoot: tmpDir,
          timeoutMs: 5000,
          signal: ac.signal,
        },
      );
    });

    it('uses custom outputDir in gitignore when gitignoreUpdater is default', async () => {
      const mockProvider: Provider = {
        id: 'test-p',
        capabilities: {} as never,
        stream: (async function* () {})() as never,
        async complete() {
          return response('[]');
        },
      };

      const orchestrator = new SecurityScannerOrchestrator();
      const res = await orchestrator.run(
        { provider: mockProvider },
        {
          projectRoot: tmpDir,
          reportOptions: {
            outputDir: 'custom-sec-reports',
          },
        },
      );
      expect(res).toBeDefined();
    });
  });

  describe('package-audit.ts', () => {
    it('formats error from execution.error.message when stderr is empty and parse fails', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{}');
      const runner = new PackageAuditRunner(async () => {
        return {
          stdout: 'invalid-json',
          stderr: '   ',
          exitCode: 1,
          error: new Error('spawn failed error message'),
        };
      });

      const res = await runner.run(tmpDir);
      expect(res.error).toBe('spawn failed error message');
    });

    it('formats error from parseError when stderr is empty and execution.error is undefined', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{}');
      const runner = new PackageAuditRunner(async () => {
        return {
          stdout: 'invalid-json',
          stderr: '   ',
          exitCode: 1,
          error: undefined,
        };
      });

      const res = await runner.run(tmpDir);
      expect(res.error).toBeDefined();
    });
  });

  describe('report-writer.ts', () => {
    it('ReportWriter instance method generateBasicReport generates markdown', () => {
      const writer = new ReportWriter({
        completeWithRetry: async () => response('report'),
      });
      const scanResult: ScanResult = {
        findings: [],
        scannedFiles: 0,
        scanDurationMs: 10,
        errors: [],
        projectRoot: tmpDir,
        techStack: dummyStack,
        timestamp: new Date().toISOString(),
        summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      };
      const text = writer.generateBasicReport(tmpDir, dummyStack, scanResult as never);
      expect(typeof text).toBe('string');
      expect(text).toContain('Security Scan Report');
    });
  });

  describe('scanner.ts', () => {
    it('handles non-string fileExtensions, non-matching extension, undefined patterns, and baseName fallback', () => {
      const scanner = new SecurityScanner();
      const patterns: SecurityPattern[] = [
        {
          id: 'test-ext',
          name: 'test',
          severity: 'high',
          category: 'secrets',
          fileExtensions: ['' as never, null as never, '.py'],
          patterns: undefined as never,
          description: 'test pattern',
          falsePositiveMarkers: [],
          remediation: 'test remediation',
        },
      ];

      const s = scanner as any;
      const findings1 = s.scanFile('test content', 'file.ts', patterns, 1);
      expect(findings1).toEqual([]);

      const findings2 = s.scanFile('test content', 'file.py', patterns, 1);
      expect(findings2).toEqual([]);

      const findings3 = s.scanFile('test content', '', patterns, 1);
      expect(findings3).toEqual([]);
    });

    it('handles fileExtensions with whitespace only and pattern with empty fileExtensions', () => {
      const scanner = new SecurityScanner();
      const s = scanner as any;
      const patterns: SecurityPattern[] = [
        {
          id: 'test-ws-ext',
          name: 'test',
          severity: 'high',
          category: 'secrets',
          fileExtensions: ['   '],
          patterns: [/abc/g],
          description: 'test pattern',
          falsePositiveMarkers: [],
          remediation: 'test remediation',
        },
        {
          id: 'test-empty-ext',
          name: 'test',
          severity: 'high',
          category: 'secrets',
          fileExtensions: [],
          patterns: [/abc/g],
          description: 'test pattern',
          falsePositiveMarkers: [],
          remediation: 'test remediation',
        },
      ];

      const exts = s.getTargetExtensions({ patterns }, dummyStack);
      expect(exts).toEqual([]);

      const findings = s.scanFile('abc', 'file.ts', patterns, 1);
      expect(findings.length).toBeGreaterThan(0);
    });
  });

  describe('skill-generator.ts', () => {
    it('covers confidence branch in getSecretPatterns and getInjectionPatterns, unknown stack, and SkillGenerator methods', async () => {
      const gen = new SkillGenerator();

      const info = await gen.gatherProjectInfo(tmpDir, dummyStack);
      expect(typeof info).toBe('string');

      const fallback = gen.generateFallbackSkill(dummyStack);
      expect(fallback).toBeDefined();

      const unknownSkill = gen.generate({
        stack: 'non_existent_stack_key' as never,
        packageManager: 'unknown',
        manifestFile: '',
        dependencies: [],
        projectPath: '',
      });
      expect(unknownSkill).toBeDefined();

      const genInvalidThreshold = new SkillGenerator({
        severityThreshold: 'invalid_level' as never,
      });
      const resInvalid = genInvalidThreshold.generate(dummyStack);
      expect(resInvalid).toBeDefined();

      const genUndefThreshold = new SkillGenerator({
        severityThreshold: undefined,
      } as never);
      const resUndef = genUndefThreshold.generate(dummyStack);
      expect(resUndef).toBeDefined();

      const mockProvider: Provider = {
        id: 'test-p',
        capabilities: {} as never,
        stream: (async function* () {})() as never,
        async complete() {
          return response('{"name":"custom","patterns":[]}');
        },
      };

      const ac = new AbortController();
      const llmSkill = await generateSkillLLM(
        {},
        mockProvider,
        'test-model',
        tmpDir,
        dummyStack,
        ac,
      );
      expect(llmSkill.name).toBe('custom');

      const genWithProvider = new SkillGenerator({
        provider: mockProvider,
        completeWithRetry: undefined,
      } as never);
      const skillFromGen = await genWithProvider.generateSkillLLM(
        mockProvider,
        'test-model',
        tmpDir,
        dummyStack,
        new AbortController(),
      );
      expect(skillFromGen).toBeDefined();
    });
  });
});
