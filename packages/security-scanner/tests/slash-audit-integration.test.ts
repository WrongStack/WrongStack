import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNodeDependencies } from '../src/manifest-parser.js';
import { PackageAuditRunner, parsePackageAuditOutput } from '../src/package-audit.js';
import { createSecuritySlashCommand } from '../src/slash-command.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

describe('/security audit integration', () => {
  it('runs the package audit executor, parses JSON, and includes findings in slash output', async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'security-audit-integration-'));
    await fs.writeFile(path.join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

    const executor = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          axios: {
            severity: 'high',
            isDirect: true,
            via: [{ title: 'Server-side request forgery' }],
            range: '<1.8.2',
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
    const orchestrator = {
      run: vi.fn().mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          scannedFiles: 1,
          scanDurationMs: 1,
        },
        detectionResult: { detectedStacks: [{ stack: 'nodejs' }] },
        synthesizedReport: '# Source scan clean',
        reportPath: path.join(projectRoot, 'security-reports', 'source.md'),
      }),
    };
    const command = createSecuritySlashCommand({
      orchestrator: orchestrator as never,
      packageAuditRunner: new PackageAuditRunner(executor),
    });

    const result = await command.run('audit', {
      projectRoot,
      cwd: projectRoot,
      provider: { complete: vi.fn() },
      model: 'test-model',
    } as never);

    expect(executor).toHaveBeenCalledWith('pnpm', ['audit', '--json'], projectRoot);
    expect(orchestrator.run).toHaveBeenCalledOnce();
    expect(result?.message).toContain('1 dependency vulnerabilities need attention');
    expect(result?.message).toContain('axios');
    expect(result?.message).toContain('# Source scan clean');
    expect(result?.metadata?.packageAudit).toEqual(
      expect.objectContaining({
        packageManager: 'pnpm',
        summary: expect.objectContaining({ high: 1, total: 1 }),
      }),
    );
  });

  it('rejects non-object audit JSON, maps metadata.vulnerabilities.medium to moderate, and ignores blank dependency versions (F136)', () => {
    expect(() => parsePackageAuditOutput('[]')).toThrow('Audit output is not a JSON object');
    const parsed = parsePackageAuditOutput(
      JSON.stringify({
        vulnerabilities: {},
        metadata: { vulnerabilities: { medium: 3, total: 3 } },
      }),
    );
    expect(parsed.summary.moderate).toBe(3);
    expect(parseNodeDependencies(JSON.stringify({ dependencies: { lodash: '   ' } }))).toEqual([]);
  });
});
