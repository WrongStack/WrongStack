import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orchestratorMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));
const packageAuditMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../src/orchestrator.js', () => ({
  defaultOrchestrator: { run: orchestratorMocks.run },
}));
vi.mock('../src/package-audit.js', () => ({
  defaultPackageAuditRunner: { run: packageAuditMocks.run },
}));

import { createSecuritySlashCommand } from '../src/slash-command.js';

let prevCwd: string;
let tmp: string;

beforeEach(async () => {
  orchestratorMocks.run.mockReset();
  packageAuditMocks.run.mockReset();
  packageAuditMocks.run.mockResolvedValue({
    packageManager: 'npm',
    command: 'npm audit --json',
    vulnerabilities: [],
    summary: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
    exitCode: 0,
    success: true,
    skipped: false,
  });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-slash-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(prevCwd);
  await fs.rm(tmp, { recursive: true, force: true });
});

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: tmp,
    cwd: tmp,
    provider: { complete: () => ({}) } as never,
    model: 'opus',
    ...overrides,
  } as never;
}

function withoutProvider() {
  return { projectRoot: tmp, cwd: tmp } as never;
}

describe('createSecuritySlashCommand', () => {
  it('falls back through cwd and process cwd when projectRoot is absent', async () => {
    const cmd = createSecuritySlashCommand();
    await cmd.run('audit-deps', { projectRoot: '', cwd: tmp } as never);
    await cmd.run('audit-deps', { projectRoot: '', cwd: '' } as never);
    await cmd.run('scan', { projectRoot: '', cwd: tmp } as never);
    await cmd.run('scan', { projectRoot: '', cwd: '' } as never);
    await cmd.run('audit', { projectRoot: '', cwd: tmp } as never);
    await cmd.run('audit', { projectRoot: '', cwd: '' } as never);
    await cmd.run('report', { projectRoot: '', cwd: tmp } as never);
    await cmd.run('report', { projectRoot: '', cwd: '' } as never);
    expect(packageAuditMocks.run).toHaveBeenCalled();
  });

  it('exposes slash command metadata', () => {
    const cmd = createSecuritySlashCommand();
    expect(cmd.name).toBe('security');
    expect(cmd.argsHint).toBeDefined();
    expect(cmd.help).toBeDefined();
  });

  it('default (no subcommand) shows help message', async () => {
    const cmd = createSecuritySlashCommand();
    const res = await cmd.run('', fakeCtx());
    expect(res?.message).toContain('/security — Security Scanner');
    expect(res?.message).toContain('scan');
    expect(res?.message).toContain('audit');
  });

  it('unknown subcommand also shows help message', async () => {
    const cmd = createSecuritySlashCommand();
    const res = await cmd.run('frobulate', fakeCtx());
    expect(res?.message).toContain('/security — Security Scanner');
  });

  // ── /security scan ─────────────────────────────────────────────────────────

  describe('scan', () => {
    it('labels a scan with no detected stack as unknown', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          scannedFiles: 0,
          scanDurationMs: 0,
        },
        detectionResult: { detectedStacks: [] },
        synthesizedReport: null,
        reportPath: '',
      });
      const res = await createSecuritySlashCommand().run('scan', fakeCtx());
      expect(res?.message).toContain('**Tech Stack:** unknown');
    });

    it('errors without provider configured', async () => {
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('scan', withoutProvider());
      expect(res?.message).toContain('requires an active LLM provider');
    });

    it('uses synthesizedReport when orchestrator provides one', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
          scannedFiles: 10,
          scanDurationMs: 100,
        },
        detectionResult: { detectedStacks: [{ stack: 'typescript' }] },
        synthesizedReport: '# Custom Report\nFancy content',
        reportPath: '/tmp/report.md',
      });
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('scan', fakeCtx());
      expect(res?.message).toContain('# Custom Report');
      expect(res?.metadata?.reportPath).toBe('/tmp/report.md');
    });

    it('falls back to built-in summary when no synthesizedReport', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          scannedFiles: 5,
          scanDurationMs: 200,
        },
        detectionResult: { detectedStacks: [{ stack: 'python' }] },
        synthesizedReport: null,
        reportPath: '/tmp/r.md',
      });
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('scan', fakeCtx());
      expect(res?.message).toContain('No issues found');
      expect(res?.message).toContain('python');
    });

    it('parses --depth and --format flags', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          scannedFiles: 0,
          scanDurationMs: 0,
        },
        detectionResult: { detectedStacks: [] },
        synthesizedReport: 'x',
        reportPath: '',
      });
      const cmd = createSecuritySlashCommand();
      await cmd.run('scan --depth deep --format html', fakeCtx());
      expect(orchestratorMocks.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scanOptions: expect.objectContaining({ depth: 'deep' }),
          reportOptions: { format: 'html' },
        }),
      );
    });

    it('uses default depth/format when not specified', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
          scannedFiles: 0,
          scanDurationMs: 0,
        },
        detectionResult: { detectedStacks: [] },
        synthesizedReport: 'x',
        reportPath: '',
      });
      const cmd = createSecuritySlashCommand();
      await cmd.run('scan', fakeCtx());
      expect(orchestratorMocks.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scanOptions: expect.objectContaining({ depth: 'standard' }),
          reportOptions: { format: 'markdown' },
        }),
      );
    });

    it('catches orchestrator errors', async () => {
      orchestratorMocks.run.mockRejectedValue(new Error('boom'));
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('scan', fakeCtx());
      expect(res?.message).toContain('Scan failed');
      expect(res?.message).toContain('boom');
    });
  });

  // ── /security audit ────────────────────────────────────────────────────────

  describe('audit', () => {
    it('labels source audit output with no detected stack as unknown', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: {
          summary: { critical: 0, high: 0, medium: 0, low: 0 },
          scannedFiles: 0,
          scanDurationMs: 0,
        },
        detectionResult: { detectedStacks: [] },
        synthesizedReport: null,
        reportPath: '/report',
      });
      const res = await createSecuritySlashCommand().run('audit', fakeCtx());
      expect(res?.message).toContain('**Tech Stack:** unknown');
    });

    it('runs dependency-only audit without invoking the source scanner', async () => {
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit-deps', fakeCtx());
      expect(res?.message).toContain('Dependency Audit Complete');
      expect(res?.metadata?.packageAudit).toBeDefined();
      expect(packageAuditMocks.run).toHaveBeenCalledWith(tmp);
      expect(orchestratorMocks.run).not.toHaveBeenCalled();
    });

    it('still runs dependency audit without a provider', async () => {
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', withoutProvider());
      expect(res?.message).toContain('No known dependency vulnerabilities');
      expect(res?.message).toContain('Source security scan skipped');
      expect(packageAuditMocks.run).toHaveBeenCalledWith(tmp);
      expect(orchestratorMocks.run).not.toHaveBeenCalled();
    });

    it('uses synthesizedReport when available', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: { summary: { critical: 2, high: 1, medium: 0, low: 0 } },
        detectionResult: { detectedStacks: [{ stack: 'go' }] },
        synthesizedReport: '# Audit',
        reportPath: '/p',
      });
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', fakeCtx());
      expect(res?.message).toContain('# Audit');
    });

    it('falls back to built-in audit summary with no issues', async () => {
      orchestratorMocks.run.mockResolvedValue({
        scanResult: { summary: { critical: 0, high: 0, medium: 0, low: 0 } },
        detectionResult: { detectedStacks: [{ stack: 'rust' }] },
        synthesizedReport: null,
        reportPath: '/p',
      });
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', fakeCtx());
      expect(res?.message).toContain('No known dependency vulnerabilities');
    });

    it('falls back to built-in audit summary with issues found', async () => {
      packageAuditMocks.run.mockResolvedValue({
        packageManager: 'pnpm',
        command: 'pnpm audit --json',
        vulnerabilities: [
          {
            name: 'lodash',
            severity: 'critical',
            via: ['prototype pollution'],
            fixAvailable: true,
          },
          { name: 'minimist', severity: 'high', via: ['parser issue'], fixAvailable: false },
        ],
        summary: { critical: 1, high: 2, moderate: 0, low: 0, info: 0, total: 3 },
        exitCode: 1,
        success: true,
        skipped: false,
      });
      orchestratorMocks.run.mockResolvedValue({
        scanResult: { summary: { critical: 1, high: 2, medium: 5, low: 10 } },
        detectionResult: { detectedStacks: [{ stack: 'node' }] },
        synthesizedReport: null,
        reportPath: '/p',
      });
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', fakeCtx());
      expect(res?.message).toContain('3 dependency vulnerabilities need attention');
      expect(res?.message).toContain('lodash');
      expect(res?.metadata?.packageAudit).toEqual(
        expect.objectContaining({ packageManager: 'pnpm' }),
      );
    });

    it('preserves dependency results when the source scan fails', async () => {
      orchestratorMocks.run.mockRejectedValue('plain');
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', fakeCtx());
      expect(res?.message).toContain('No known dependency vulnerabilities');
      expect(res?.message).toContain('Source security scan failed: plain');
      expect(res?.metadata?.packageAudit).toBeDefined();
    });

    it('reports unexpected dependency runner failures', async () => {
      packageAuditMocks.run.mockRejectedValue(new Error('spawn exploded'));
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('audit', fakeCtx());
      expect(res?.message).toContain('Dependency audit failed');
      expect(res?.message).toContain('spawn exploded');
      expect(orchestratorMocks.run).not.toHaveBeenCalled();
    });

    it('reports dependency-only runner exceptions', async () => {
      packageAuditMocks.run.mockRejectedValue('runner offline');
      const res = await createSecuritySlashCommand().run('audit-deps', fakeCtx());
      expect(res?.message).toContain('Dependency audit failed: runner offline');
    });

    it('uses default explanations for skipped and failed audit results', async () => {
      packageAuditMocks.run.mockResolvedValueOnce({
        vulnerabilities: [],
        summary: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
        exitCode: null,
        success: false,
        skipped: true,
      });
      const skipped = await createSecuritySlashCommand().run('audit-deps', fakeCtx());
      expect(skipped?.message).toContain('no supported lockfile found');

      packageAuditMocks.run.mockResolvedValueOnce({
        vulnerabilities: [],
        summary: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
        exitCode: null,
        success: false,
        skipped: false,
      });
      const failed = await createSecuritySlashCommand().run('audit-deps', fakeCtx());
      expect(failed?.message).toContain('unknown error');
    });
  });

  describe('redact-test', () => {
    it('returns field names and never returns synthetic secret values', async () => {
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('redact-test', fakeCtx());
      expect(res?.message).toContain('Secret Redaction Diagnostic');
      expect(res?.metadata?.redactedCount).toBeGreaterThan(0);
      expect(res?.metadata?.redactedFields).toEqual(
        expect.arrayContaining([expect.stringMatching(/^\$\./)]),
      );
      expect(res?.message).not.toContain('sk-1234567890');
      expect(res?.message).not.toContain('p4ssw0rd');
    });
  });

  // ── /security report ───────────────────────────────────────────────────────

  describe('report', () => {
    it('lists no reports when directory missing', async () => {
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('report', fakeCtx());
      expect(res?.message).toContain('No security reports');
    });

    it('lists existing reports sorted newest first', async () => {
      const dir = path.join(tmp, 'security-reports');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'security-report-2026-01-01.md'), '# Old');
      await fs.writeFile(path.join(dir, 'security-report-2026-05-22.md'), '# Recent');
      await fs.writeFile(path.join(dir, 'security-report-2026-06-01.html'), '<h1>Newest</h1>');
      await fs.writeFile(path.join(dir, 'unrelated.txt'), 'skip');
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('report', fakeCtx());
      expect(res?.message).toContain('Available Security Reports');
      expect(res?.message).toContain('2026-05-22');
      expect(res?.message).toContain('2026-01-01');
      expect(res?.message).toContain('2026-06-01');
      expect(res?.message).not.toContain('unrelated');
    });

    it('shows the Nth report when ID is a numeric index', async () => {
      const dir = path.join(tmp, 'security-reports');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'security-report-2026-01-01.md'), '# Old content');
      await fs.writeFile(path.join(dir, 'security-report-2026-05-22.md'), '# Recent content');
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('report 1', fakeCtx());
      expect(res?.message).toContain('# Recent content');
    });

    it('finds a report by date substring', async () => {
      const dir = path.join(tmp, 'security-reports');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'security-report-2026-01-01.md'), '# Jan');
      await fs.writeFile(path.join(dir, 'security-report-2026-05-22.md'), '# May');
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('report 2026-01', fakeCtx());
      expect(res?.message).toContain('# Jan');
    });

    it('lists and displays .markdown reports generated by default format', async () => {
      const dir = path.join(tmp, 'security-reports');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'security-report-2026-07-01T12-00-00.markdown'),
        '# Default Markdown Report\nBody content',
      );
      const cmd = createSecuritySlashCommand();
      const list = await cmd.run('report', fakeCtx());
      expect(list?.message).toContain('Available Security Reports');
      expect(list?.message).toContain('2026-07-01T12-00-00');

      const view = await cmd.run('report 1', fakeCtx());
      expect(view?.message).toContain('# Default Markdown Report');
      expect(view?.message).toContain('Body content');
    });

    it('reports not-found for unknown ID', async () => {
      const dir = path.join(tmp, 'security-reports');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'security-report-2026-01-01.md'), 'x');
      const cmd = createSecuritySlashCommand();
      const res = await cmd.run('report 9999-99-99', fakeCtx());
      expect(res?.message).toContain('not found');
    });
  });
});
