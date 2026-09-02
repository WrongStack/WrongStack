/**
 * Edge-case tests for ReportGenerator covering remaining branches:
 * - Medium and low severity emoji in markdown (grouped by severity)
 * - groupByCategory with multiple findings of the same category
 * - groupBySeverity with unknown severity
 * - The ?? fallback when severityGroups entry is unexpectedly absent
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportGenerator } from '../src/report-generator.js';
import type { Finding, ScanResult } from '../src/scanner.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'report-edge-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    title: 'Test Finding',
    severity: 'medium',
    category: 'secrets',
    file: 'src/test.ts',
    line: 10,
    snippet: 'const x = 1;',
    remediation: 'Fix it',
    ...over,
  } as Finding;
}

function mkScanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: '2026-06-01T12:00:00.000Z',
    projectRoot: '/proj',
    techStack: { stack: 'typescript', packageManager: 'pnpm' } as never,
    scannedFiles: 5,
    scanDurationMs: 200,
    summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    findings: [],
    errors: [],
    ...over,
  } as ScanResult;
}

describe('ReportGenerator - edge coverage', () => {
  it('treats a missing severity bucket as empty', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r') });
    vi.spyOn(
      gen as never as { groupBySeverity(findings: Finding[]): Record<string, Finding[]> },
      'groupBySeverity',
    ).mockReturnValue({ critical: [], high: [], medium: [] });
    const file = await gen.generate(mkScanResult());
    expect(await fs.readFile(file, 'utf8')).toContain('# Security Scan Report');
  });

  // ── Medium severity emoji in markdown ──────────────────────────────────────
  it('renders medium severity emoji in markdown', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r') });
    const file = await gen.generate(
      mkScanResult({
        findings: [mkFinding({ severity: 'medium', title: 'Medium Issue' })],
        summary: { critical: 0, high: 0, medium: 1, low: 0, total: 1 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    expect(md).toContain('MEDIUM (1)');
    expect(md).toContain('🟡');
  });

  // ── Low severity emoji in markdown ─────────────────────────────────────────
  it('renders low severity emoji in markdown', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r') });
    const file = await gen.generate(
      mkScanResult({
        findings: [mkFinding({ severity: 'low', title: 'Low Issue' })],
        summary: { critical: 0, high: 0, medium: 0, low: 1, total: 1 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    expect(md).toContain('LOW (1)');
    expect(md).toContain('🟢');
  });

  // ── groupByCategory with duplicate categories ──────────────────────────────
  it('groups multiple findings of same category together', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r'), groupBySeverity: false });
    const file = await gen.generate(
      mkScanResult({
        findings: [
          mkFinding({ category: 'secrets', title: 'Secret A', severity: 'critical' }),
          mkFinding({ category: 'secrets', title: 'Secret B', severity: 'high' }),
          mkFinding({ category: 'injection', title: 'Inject', severity: 'critical' }),
        ],
        summary: { critical: 2, high: 1, medium: 0, low: 0, total: 3 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    expect(md).toContain('SECRETS (2)');
    expect(md).toContain('INJECTION (1)');
  });

  // ── groupBySeverity with unknown severity (the if(group) false branch) ────
  it('skips findings with unknown severity in groupBySeverity', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r'), groupBySeverity: true });
    const file = await gen.generate(
      mkScanResult({
        findings: [mkFinding({ severity: 'gibberish' as never, title: 'Unknown Sev' })],
        summary: { critical: 0, high: 0, medium: 0, low: 0, total: 1 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    // The finding with unknown severity should be silently skipped by groupBySeverity
    // (the `if (group)` check at line 183 prevents the push)
    // So no group header for 'GIBBERISH' — unknown severity doesn't match any section
    expect(md).not.toContain('GIBBERISH');
    // But the finding itself is rendered under which section? It's simply skipped.
    // Let's verify the report doesn't contain the title (since it's skipped)
    expect(md).not.toContain('Unknown Sev');
  });

  // ── All four severity emojis in the markdown summary ───────────────────────
  it('renders all four severity emojis in markdown when all severities are present', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r') });
    const file = await gen.generate(
      mkScanResult({
        findings: [
          mkFinding({ severity: 'critical', title: 'Critical Issue' }),
          mkFinding({ severity: 'high', title: 'High Issue' }),
          mkFinding({ severity: 'medium', title: 'Medium Issue' }),
          mkFinding({ severity: 'low', title: 'Low Issue' }),
        ],
        summary: { critical: 1, high: 1, medium: 1, low: 1, total: 4 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    // Summary table emits all four emojis
    expect(md).toContain('🔴');
    expect(md).toContain('🟠');
    expect(md).toContain('🟡');
    expect(md).toContain('🟢');
    // Severity section headers also carry the emojis with counts
    expect(md).toContain('🔴 CRITICAL (1)');
    expect(md).toContain('🟠 HIGH (1)');
    expect(md).toContain('🟡 MEDIUM (1)');
    expect(md).toContain('🟢 LOW (1)');
  });

  // ── formatFinding without line number ──────────────────────────────────────
  it('formats finding without line number correctly', async () => {
    const gen = new ReportGenerator({ outputDir: path.join(tmp, 'r') });
    const file = await gen.generate(
      mkScanResult({
        findings: [mkFinding({ line: undefined, title: 'No Line' })],
        summary: { critical: 0, high: 0, medium: 1, low: 0, total: 1 } as never,
      }),
    );
    const md = await fs.readFile(file, 'utf8');
    expect(md).toContain('No Line');
    // The file path should appear without a line suffix
    expect(md).toContain('src/test.ts');
  });
});
