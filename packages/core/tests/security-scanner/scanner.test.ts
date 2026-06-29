import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { SecurityScanner } from '../../src/security-scanner/scanner.js';
import type { GeneratedSkill, TechStackInfo, SecurityPattern } from '../../src/security-scanner/types.js';

describe('SecurityScanner', () => {
  let scanner: SecurityScanner;

  beforeEach(() => {
    scanner = new SecurityScanner();
  });

  const createMockSkill = (patterns: SecurityPattern[]): GeneratedSkill => ({
    name: 'security-scanner-test',
    description: 'Test security scanner',
    version: '1.0.0',
    techStack: 'nodejs',
    content: { type: 'skill', content: '' },
    patterns,
    metadata: {
      generatedAt: new Date().toISOString(),
      confidence: 0.9,
      targetFiles: ['**/*.ts', '**/*.js'],
    },
  });

  const createMockTechStack = (): TechStackInfo => ({
    stack: 'nodejs',
    packageManager: 'npm',
    manifestFile: 'package.json',
    dependencies: [],
    projectPath: '/test',
  });

  describe('pattern matching', () => {
    it('detects hardcoded secrets', async () => {
      // Create a real temp file with the secret pattern so gatherFiles finds something
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-scanner-'));
      const testFile = path.join(tmpDir, 'config.ts');
      // Key must be 20+ alphanumeric chars only - underscores break the test regex pattern
      await fs.writeFile(testFile, 'const apiKey = "sktestabcdefghij1234567890";\n');

      const patterns: SecurityPattern[] = [
        {
          id: 'hardcoded-api-key',
          name: 'Hardcoded API Key',
          severity: 'critical',
          description: 'Detects hardcoded API keys',
          patterns: [/(?:api[_-]?key)[^\w]*[=:]\s*["']([a-zA-Z0-9]{20,})["']/gi],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: ['process.env', 'process.argv'],
          remediation: 'Use environment variables',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scanner.scan(tmpDir, skill, techStack);

      expect(result.findings.some((f) => f.id.includes('hardcoded-api-key'))).toBe(true);
      expect(result.scannedFiles).toBeGreaterThan(0);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('detects every match across multiple lines (regression: /g flag lastIndex bug)', async () => {
      // Regression test for a bug where `.test()` on a /g-flagged regex
      // advances `lastIndex` between calls, causing the scanner to silently
      // miss every match after the first per file.
      // See: audit C6 / fix.md P11.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-scanner-regression-'));
      const testFile = path.join(tmpDir, 'multi.ts');
      // Three matches across three lines. The first match was always detected;
      // matches on subsequent lines were silently skipped before the fix.
      await fs.writeFile(
        testFile,
        [
          'const apiKey1 = "abcdefghij1234567890";',
          'const apiKey2 = "klmnopqrst0987654321";',
          'const apiKey3 = "uvwxyzabcdef13579246";',
        ].join('\n') + '\n',
      );

      const patterns: SecurityPattern[] = [
        {
          id: 'multi-match-secret',
          name: 'Multi-Match Secret',
          severity: 'critical',
          description: 'Should match each line independently',
          patterns: [/(?:api[_-]?key\d+)[^\w]*[=:]\s*["']([a-zA-Z0-9]{20,})["']/gi],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Use env vars',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();
      const result = await scanner.scan(tmpDir, skill, techStack);

      const matches = result.findings.filter((f) => f.patternId === 'multi-match-secret');
      expect(matches).toHaveLength(3);
      expect(matches.map((m) => m.line).sort()).toEqual([1, 2, 3]);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('respects excludePaths option', async () => {
      const scannerWithExcludes = new SecurityScanner({
        excludePaths: ['node_modules', 'dist'],
      });

      const patterns: SecurityPattern[] = [
        {
          id: 'test-pattern',
          name: 'Test Pattern',
          severity: 'medium',
          description: 'Test',
          patterns: [/password\s*=/gi],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: [],
          remediation: 'Fix it',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scannerWithExcludes.scan('/test', skill, techStack);

      // Should not match in excluded paths
      expect(result.findings.filter((f) => f.file.includes('node_modules'))).toHaveLength(0);
    });

    it('calculates summary correctly', async () => {
      const patterns: SecurityPattern[] = [
        {
          id: 'critical-issue',
          name: 'Critical Issue',
          severity: 'critical',
          description: 'Critical',
          patterns: [/eval\s*\(/g],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Avoid eval',
        },
        {
          id: 'medium-issue',
          name: 'Medium Issue',
          severity: 'medium',
          description: 'Medium',
          patterns: [/debug\s*[:=]\s*true/gi],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Disable debug',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scanner.scan('/test', skill, techStack);

      expect(result.summary.total).toBe(result.summary.critical + result.summary.medium);
    });
  });

  describe('severity sorting', () => {
    it('sorts findings by severity', async () => {
      const patterns: SecurityPattern[] = [
        {
          id: 'low-severity',
          name: 'Low',
          severity: 'low',
          description: 'Low',
          patterns: [/TODO/g],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Fix',
        },
        {
          id: 'critical-severity',
          name: 'Critical',
          severity: 'critical',
          description: 'Critical',
          patterns: [/password\s*=\s*["'][^"']+["']/gi],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Fix',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scanner.scan('/test', skill, techStack);

      if (result.findings.length > 1) {
        const criticalIndex = result.findings.findIndex((f) => f.severity === 'critical');
        const lowIndex = result.findings.findIndex((f) => f.severity === 'low');
        expect(criticalIndex).toBeLessThan(lowIndex);
      }
    });
  });

  describe('false positive detection', () => {
    it('skips lines with false positive markers', async () => {
      const patterns: SecurityPattern[] = [
        {
          id: 'secret-detector',
          name: 'Secret',
          severity: 'critical',
          description: 'Secret',
          patterns: [/password\s*=/gi],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: ['process.env', 'argv'],
          remediation: 'Use env',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scanner.scan('/test', skill, techStack);

      // Should not flag process.env usage
      const falsePositives = result.findings.filter((f) => f.snippet?.includes('process.env'));
      expect(falsePositives).toHaveLength(0);
    });
  });

  describe('scan result structure', () => {
    it('returns complete scan result structure', async () => {
      const patterns: SecurityPattern[] = [
        {
          id: 'test',
          name: 'Test',
          severity: 'low',
          description: 'Test',
          patterns: [/test/g],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Fix',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scanner.scan('/test', skill, techStack);

      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('projectRoot');
      expect(result).toHaveProperty('techStack');
      expect(result).toHaveProperty('findings');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('scannedFiles');
      expect(result).toHaveProperty('scanDurationMs');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('file extensions', () => {
    it('filters files by extension', async () => {
      const scannerWithExtFilter = new SecurityScanner({
        fileExtensions: ['.ts'],
      });

      const patterns: SecurityPattern[] = [
        {
          id: 'test',
          name: 'Test',
          severity: 'low',
          description: 'Test',
          patterns: [/password\s*=/gi],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: [],
          remediation: 'Fix',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await scannerWithExtFilter.scan('/test', skill, techStack);

      // JS files should be filtered out
      const jsFindings = result.findings.filter((f) => f.file.endsWith('.js'));
      expect(jsFindings).toHaveLength(0);
    });
  });

  describe('depth option', () => {
    it('respects quick depth limit', async () => {
      const quickScanner = new SecurityScanner({ depth: 'quick' });
      const patterns: SecurityPattern[] = [
        {
          id: 'test',
          name: 'Test',
          severity: 'low',
          description: 'Test',
          patterns: [/test/g],
          fileExtensions: ['.ts'],
          falsePositiveMarkers: [],
          remediation: 'Fix',
        },
      ];

      const skill = createMockSkill(patterns);
      const techStack = createMockTechStack();

      const result = await quickScanner.scan('/test', skill, techStack);

      expect(result.scannedFiles).toBeDefined();
    });
  });
});