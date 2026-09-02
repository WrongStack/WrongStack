import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { Provider, SlashCommand } from '@wrongstack/core/types';
import { defaultOrchestrator } from './orchestrator.js';
import type { PackageAuditResult, PackageAuditRunner } from './package-audit.js';
import { defaultPackageAuditRunner } from './package-audit.js';
import { runRedactionDiagnostic } from './redaction-diagnostic.js';

export interface SecuritySlashCommandDependencies {
  orchestrator?: Pick<typeof defaultOrchestrator, 'run'> | undefined;
  packageAuditRunner?: Pick<PackageAuditRunner, 'run'> | undefined;
}

export function createSecuritySlashCommand(
  dependencies: SecuritySlashCommandDependencies = {},
): SlashCommand {
  const orchestrator = dependencies.orchestrator ?? defaultOrchestrator;
  const packageAuditRunner = dependencies.packageAuditRunner ?? defaultPackageAuditRunner;
  return {
    name: 'security',
    description: 'Security scanning commands: scan, audit, report, redact-test',
    category: 'Inspect',
    argsHint: '[scan|audit|audit-deps|report|redact-test] [options]',
    help: `
# /security — Security Scanner

Security scanning with automatic tech stack detection.

## Commands

### /security scan [options]
Run a full security scan on the current project.
Options:
  --depth quick|standard|deep  Scan depth (default: standard)
  --format markdown|json|html   Report format (default: markdown)

### /security audit
Run dependency audit + security scan.
Checks for known vulnerabilities in dependencies.

### /security audit-deps
Run only the package-manager dependency audit.

### /security report [id]
Show a previous security report.
  /security report          - List available reports
  /security report <id>     - Show specific report

## Examples

/security scan
/security scan --depth deep --format html
/security audit
/security audit-deps
/security report
/security redact-test
/security report 2025-01-15
`,
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || '';
      const subArgs = parts.slice(1).join(' ');

      switch (subcommand) {
        case 'scan':
          return handleScan(subArgs, ctx, orchestrator);
        case 'audit':
          return handleAudit(ctx, orchestrator, packageAuditRunner);
        case 'audit-deps':
          return handleDependencyAudit(ctx, packageAuditRunner);
        case 'report':
          return handleReport(subArgs, ctx);
        case 'redact-test':
          return handleRedactionDiagnostic();
        default:
          return { message: getHelpMessage() };
      }
    },
  };
}

async function handleDependencyAudit(
  ctx: Context,
  packageAuditRunner: Pick<PackageAuditRunner, 'run'>,
): Promise<{ message?: string | undefined; metadata?: Record<string, unknown> }> {
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();
  try {
    const packageAudit = await packageAuditRunner.run(projectRoot);
    return {
      message: `# Dependency Audit Complete\n\n**Project:** ${projectRoot}\n\n${formatPackageAudit(packageAudit)}`,
      metadata: { packageAudit },
    };
  } catch (error) {
    return { message: `❌ Dependency audit failed: ${error}` };
  }
}

function getProviderFromContext(
  ctx: Context,
): { provider: Provider; model?: string | undefined } | null {
  if (ctx.provider && typeof ctx.provider.complete === 'function') {
    return { provider: ctx.provider, model: ctx.model };
  }
  return null;
}

async function handleScan(
  args: string,
  ctx: Context,
  orchestrator: Pick<typeof defaultOrchestrator, 'run'>,
): Promise<{ message?: string | undefined; metadata?: Record<string, unknown> }> {
  const options = parseArgs(args);
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();

  try {
    const providerInfo = getProviderFromContext(ctx);
    if (!providerInfo) {
      return {
        message: '❌ Security scan requires an active LLM provider. No provider configured.',
      };
    }

    const result = await orchestrator.run(providerInfo, {
      projectRoot,
      scanOptions: {
        depth: (options.depth as 'quick' | 'standard' | 'deep') || 'standard',
        includeSecrets: true,
        includeInjection: true,
        includeConfig: true,
      },
      reportOptions: {
        format: (options.format as 'markdown' | 'json' | 'html') || 'markdown',
      },
    });

    const summary = result.scanResult.summary;
    const status = summary.total === 0 ? '✅ No issues found' : `⚠️ Found ${summary.total} issues`;

    // Use LLM-synthesized report if available, otherwise use basic summary
    const reportContent =
      result.synthesizedReport ||
      `# Security Scan Complete

**Project:** ${projectRoot}
**Tech Stack:** ${result.detectionResult.detectedStacks[0]?.stack || 'unknown'}
**Scanned Files:** ${result.scanResult.scannedFiles}
**Duration:** ${result.scanResult.scanDurationMs}ms

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | ${summary.critical} |
| 🟠 High | ${summary.high} |
| 🟡 Medium | ${summary.medium} |
| 🟢 Low | ${summary.low} |

**Status:** ${status}

**Report:** ${result.reportPath}
`;

    return {
      message: reportContent,
      metadata: {
        scanResult: result.scanResult,
        reportPath: result.reportPath,
        techStack: result.detectionResult.detectedStacks[0],
      },
    };
  } catch (error) {
    return { message: `❌ Scan failed: ${error}` };
  }
}

async function handleAudit(
  ctx: Context,
  orchestrator: Pick<typeof defaultOrchestrator, 'run'>,
  packageAuditRunner: Pick<PackageAuditRunner, 'run'>,
): Promise<{ message?: string | undefined; metadata?: Record<string, unknown> }> {
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();

  let packageAudit: PackageAuditResult;
  try {
    packageAudit = await packageAuditRunner.run(projectRoot);
  } catch (error) {
    return { message: `❌ Dependency audit failed: ${error}` };
  }

  const providerInfo = getProviderFromContext(ctx);
  if (!providerInfo) {
    return {
      message: buildAuditMessage(
        projectRoot,
        'unknown',
        packageAudit,
        '⚪ Source security scan skipped: no active LLM provider configured.',
      ),
      metadata: { packageAudit },
    };
  }

  try {
    const result = await orchestrator.run(providerInfo, {
      projectRoot,
      reportOptions: { format: 'markdown' },
    });

    const scanSummary = result.scanResult.summary;
    const scanContent =
      result.synthesizedReport ||
      `
## Source Scan Summary

| Severity | Count |
|----------|-------|
| Critical | ${scanSummary.critical} |
| High | ${scanSummary.high} |
| Medium | ${scanSummary.medium} |
| Low | ${scanSummary.low} |

**Full Report:** ${result.reportPath}
`;
    return {
      message: buildAuditMessage(
        projectRoot,
        result.detectionResult.detectedStacks[0]?.stack || 'unknown',
        packageAudit,
        scanContent,
      ),
      metadata: {
        scanResult: result.scanResult,
        packageAudit,
        reportPath: result.reportPath,
      },
    };
  } catch (error) {
    return {
      message: buildAuditMessage(
        projectRoot,
        'unknown',
        packageAudit,
        `⚠️ Source security scan failed: ${error}`,
      ),
      metadata: { packageAudit },
    };
  }
}

function buildAuditMessage(
  projectRoot: string,
  techStack: string,
  packageAudit: PackageAuditResult,
  scanContent: string,
): string {
  return `
# Security Audit Complete

**Project:** ${projectRoot}
**Tech Stack:** ${techStack}

${formatPackageAudit(packageAudit)}

## Source Security Scan

${scanContent}
`;
}

function formatPackageAudit(result: PackageAuditResult): string {
  const lines = ['## Dependency Audit', ''];
  if (result.skipped) {
    lines.push(`⚪ Dependency audit skipped: ${result.error ?? 'no supported lockfile found'}`);
    return lines.join('\n');
  }
  if (!result.success) {
    lines.push(`⚠️ Dependency audit could not complete: ${result.error ?? 'unknown error'}`);
    return lines.join('\n');
  }

  lines.push(`**Command:** \`${result.command}\``);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  lines.push(`| Critical | ${result.summary.critical} |`);
  lines.push(`| High | ${result.summary.high} |`);
  lines.push(`| Moderate | ${result.summary.moderate} |`);
  lines.push(`| Low | ${result.summary.low} |`);
  lines.push(`| Info | ${result.summary.info} |`);
  lines.push('');
  if (result.summary.total === 0) {
    lines.push('✅ No known dependency vulnerabilities reported');
  } else {
    lines.push(`⚠️ ${result.summary.total} dependency vulnerabilities need attention`);
    for (const vulnerability of result.vulnerabilities) {
      const fix = vulnerability.fixAvailable ? 'fix available' : 'manual review required';
      lines.push(`- **${vulnerability.name}** (${vulnerability.severity}) — ${fix}`);
    }
  }
  return lines.join('\n');
}

async function handleReport(
  reportId: string,
  ctx: Context,
): Promise<{ message?: string | undefined }> {
  const projectRoot = ctx.projectRoot || ctx.cwd || process.cwd();
  const reportsDir = join(projectRoot, 'security-reports');

  try {
    const files = await readdir(reportsDir);
    const reports = files
      .filter(
        (f) =>
          f.startsWith('security-report-') &&
          (f.endsWith('.markdown') ||
            f.endsWith('.md') ||
            f.endsWith('.json') ||
            f.endsWith('.html')),
      )
      .sort()
      .reverse();

    if (!reportId) {
      // List all reports
      if (reports.length === 0) {
        return { message: '📭 No security reports found. Run `/security scan` first.' };
      }

      const list = reports
        .map((r, i) => {
          const date = r.replace('security-report-', '').replace(/\.(markdown|md|json|html)$/, '');
          return `  ${i + 1}. ${date}`;
        })
        .join('\n');

      return {
        message: `# Available Security Reports\n\n${list}\n\nUse \`/security report <number>\` to view a specific report.`,
      };
    }

    // Show specific report
    const index = Number.parseInt(reportId, 10) - 1;
    if (!Number.isNaN(index) && reports[index]) {
      const content = await readFile(join(reportsDir, reports[index]), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    // Try to find by ID/date
    const match = reports.find((r) => r.includes(reportId));
    if (match) {
      const content = await readFile(join(reportsDir, match), 'utf-8');
      return { message: `# Security Report\n\n${content}` };
    }

    return {
      message: `❌ Report "${reportId}" not found. Use \`/security report\` to see available reports.`,
    };
  } catch (_error) {
    return { message: '📭 No security reports found. Run `/security scan` first.' };
  }
}

function handleRedactionDiagnostic(): {
  message: string;
  metadata: Record<string, unknown>;
} {
  const result = runRedactionDiagnostic();
  const ok = result.redactedFields.length > 0;
  return {
    message: [
      '# Secret Redaction Diagnostic',
      '',
      ok
        ? `✅ ${result.redactedFields.length} synthetic secret fields were redacted.`
        : '❌ No synthetic secret fields were redacted.',
      '',
      ...result.redactedFields.map((field) => `- ${field}: [REDACTED:synthetic-secret]`),
      '',
      `${result.unchangedFields.length} non-sensitive fields passed through unchanged.`,
    ].join('\n'),
    metadata: {
      redactedCount: result.redactedFields.length,
      redactedFields: result.redactedFields,
      unchangedCount: result.unchangedFields.length,
      unchangedFields: result.unchangedFields,
    },
  };
}

function parseArgs(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = args.split(/\s+/);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part?.startsWith('--')) continue;

    const key = part.slice(2);
    const next = parts[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = 'true';
    }
  }

  return result;
}

function getHelpMessage(): string {
  return `
# /security — Security Scanner

**Available Commands:**

1. **/security scan** — Run full security scan
   Options: --depth quick|standard|deep, --format markdown|json|html

2. **/security audit** — Run dependency audit + security scan

3. **/security audit-deps** — Run only the dependency audit

4. **/security report** — List or view security reports

5. **/security redact-test** — Verify production secret redaction

**Examples:**
\`\`\`
/security scan
/security scan --depth deep --format html
/security audit
/security audit-deps
/security report
/security redact-test
\`\`\`
`;
}

export const securitySlashCommand = createSecuritySlashCommand();
