import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PackageAuditRunner,
  detectAuditablePackageManager,
  parsePackageAuditOutput,
} from '../src/package-audit.js';

const temporaryDirectories: string[] = [];

async function temporaryProject(files: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-audit-'));
  temporaryDirectories.push(root);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), '')));
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('PackageAuditRunner', () => {
  it('runs pnpm audit with an argument array and parses non-zero vulnerability output', async () => {
    const root = await temporaryProject(['pnpm-lock.yaml']);
    const executor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: 'high',
            isDirect: true,
            range: '<4.17.21',
            via: [{ title: 'Prototype Pollution' }],
            fixAvailable: true,
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
        },
      }),
      stderr: '',
      exitCode: 1,
    });

    const result = await new PackageAuditRunner(executor).run(root);

    expect(executor).toHaveBeenCalledWith('pnpm', ['audit', '--json'], root);
    expect(result.success).toBe(true);
    expect(result.summary.high).toBe(1);
    expect(result.vulnerabilities[0]).toEqual(
      expect.objectContaining({ name: 'lodash', fixAvailable: true }),
    );
  });

  it('skips projects without a supported lockfile', async () => {
    const root = await temporaryProject(['package.json']);
    const executor = vi.fn();
    const result = await new PackageAuditRunner(executor).run(root);
    expect(result.skipped).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('returns a structured failure for invalid or offline output', async () => {
    const root = await temporaryProject(['package-lock.json']);
    const result = await new PackageAuditRunner(async () => ({
      stdout: '',
      stderr: 'network unavailable',
      exitCode: 2,
      error: new Error('failed'),
    })).run(root);
    expect(result).toEqual(
      expect.objectContaining({ success: false, skipped: false, error: 'network unavailable' }),
    );
  });

  it('surfaces execution error message when stderr is empty', async () => {
    const root = await temporaryProject(['package-lock.json']);
    const result = await new PackageAuditRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      error: new Error('spawn npm.cmd ENOENT'),
    })).run(root);
    expect(result).toEqual(
      expect.objectContaining({ success: false, skipped: false, error: 'spawn npm.cmd ENOENT' }),
    );
  });

  it('prefers pnpm when both supported lockfiles exist', async () => {
    const root = await temporaryProject(['pnpm-lock.yaml', 'package-lock.json']);
    expect(await detectAuditablePackageManager(root)).toBe('pnpm');
  });
});

describe('parsePackageAuditOutput', () => {
  it('derives a summary when metadata counts are absent', () => {
    const parsed = parsePackageAuditOutput(
      JSON.stringify({
        vulnerabilities: {
          one: { severity: 'critical', via: ['advisory'], fixAvailable: false },
          two: { severity: 'low', via: [], fixAvailable: { name: 'two', version: '2.0.0' } },
        },
      }),
    );
    expect(parsed.summary).toEqual({
      critical: 1,
      high: 0,
      moderate: 0,
      low: 1,
      info: 0,
      total: 2,
    });
  });

  it('supports legacy pnpm/npm advisory output and totals metadata counts', () => {
    const parsed = parsePackageAuditOutput(
      JSON.stringify({
        advisories: {
          '100': {
            module_name: 'legacy-package',
            severity: 'moderate',
            vulnerable_versions: '<2.0.0',
            title: 'Legacy advisory',
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
        },
      }),
    );
    expect(parsed.summary.total).toBe(1);
    expect(parsed.vulnerabilities[0]).toEqual(
      expect.objectContaining({ name: 'legacy-package', severity: 'moderate' }),
    );
  });

  it('surfaces structured audit errors', () => {
    expect(() =>
      parsePackageAuditOutput(JSON.stringify({ error: { summary: 'registry unavailable' } })),
    ).toThrow('registry unavailable');
  });

  it('rejects primitive and differently shaped audit errors', () => {
    expect(() => parsePackageAuditOutput('null')).toThrow('not a JSON object');
    expect(() => parsePackageAuditOutput(JSON.stringify({ error: 'plain failure' }))).toThrow(
      'plain failure',
    );
    expect(() => parsePackageAuditOutput(JSON.stringify({ error: 42 }))).toThrow(
      'Package audit reported an error',
    );
    expect(() => parsePackageAuditOutput(JSON.stringify({ error: {} }))).toThrow(
      'Package audit reported an error',
    );
  });

  it('normalizes malformed vulnerability and advisory fields', () => {
    const parsed = parsePackageAuditOutput(
      JSON.stringify({
        vulnerabilities: {
          ignored: null,
          odd: {
            severity: 'mystery',
            isDirect: 'yes',
            range: 12,
            via: [{ source: 123 }, { source: 'CVE-X' }, { title: 55 }, null, 'direct advisory'],
          },
          noVia: { severity: 'low', via: null },
        },
        advisories: { ignored: null },
        metadata: { vulnerabilities: { total: Number.POSITIVE_INFINITY, high: 'one' } },
      }),
    );
    expect(parsed.vulnerabilities).toEqual([
      {
        name: 'odd',
        severity: 'unknown',
        isDirect: undefined,
        range: undefined,
        via: ['123', 'CVE-X', 'direct advisory'],
        fixAvailable: false,
      },
      {
        name: 'noVia',
        severity: 'low',
        isDirect: undefined,
        range: undefined,
        via: [],
        fixAvailable: false,
      },
    ]);
    expect(parsed.summary.total).toBe(2);
  });

  it('uses advisory ids and empty fields when legacy details are malformed', () => {
    const parsed = parsePackageAuditOutput(
      JSON.stringify({
        vulnerabilities: 'invalid',
        advisories: {
          ignored: null,
          '404': {
            module_name: 99,
            severity: 'info',
            vulnerable_versions: false,
            title: 12,
          },
        },
        metadata: null,
      }),
    );
    expect(parsed.vulnerabilities[0]).toEqual({
      name: '404',
      severity: 'info',
      range: undefined,
      via: [],
      fixAvailable: false,
    });
    expect(parsed.summary.info).toBe(1);
  });
});
