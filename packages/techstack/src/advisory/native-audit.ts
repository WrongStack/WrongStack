/**
 * TechStack — Native audit command wrappers.
 *
 * Spawns ecosystem-native audit tools (npm audit, pip-audit, cargo-audit,
 * govulncheck, composer audit, dotnet package audit) and parses their
 * output into the TechStack advisory model.
 *
 * @see docs/specs/techstack-sdd.md §6, §7
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { EcosystemId, Evidence } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface NativeAdvisory {
  readonly id: string;
  readonly packageName: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly summary: string;
  readonly fixVersion?: string | undefined;
  readonly url?: string | undefined;
  readonly aliases: readonly string[];
}

export interface NativeAuditResult {
  readonly advisories: readonly NativeAdvisory[];
  readonly evidence: Evidence;
}

// ── Parse helpers ──────────────────────────────────────────────────────────

/** Map npm audit severity strings */
function npmSeverity(s: string): NativeAdvisory['severity'] {
  switch (s.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

/** Map cargo-audit severity strings */
function cargoSeverity(s: string): NativeAdvisory['severity'] {
  switch (s.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

// ── npm audit ──────────────────────────────────────────────────────────────

/**
 * Run npm audit in the given workspace directory and parse JSON output.
 */
export async function runNpmAudit(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  const result = await runner('npm', ['audit', '--json'], workspaceRoot);
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0 || result.status === 1) {
    // npm audit exits 0 if no vulns, 1 if vulns found, 2 if error
    try {
      const json = JSON.parse(result.stdout || '{}');
      const vulnerabilities = json.vulnerabilities as
        | Record<string, Record<string, unknown>>
        | undefined;

      if (vulnerabilities) {
        for (const [pkg, info] of Object.entries(vulnerabilities)) {
          const via = info.via as Array<Record<string, unknown> | string> | undefined;
          if (!via) continue;

          for (const advisory of via) {
            if (typeof advisory === 'string') continue;
            const source = advisory.source as number | undefined;
            const name = advisory.name as string | undefined;
            // npm uses numeric source references — skip those
            if (typeof source === 'number') continue;

            advisories.push({
              id:
                (advisory.cve as string) ??
                (advisory.ghsa as string) ??
                `npm-${pkg}-${name ?? 'unknown'}`,
              packageName: pkg,
              severity: npmSeverity((info.severity as string) ?? 'info'),
              summary: (advisory.title as string) ?? name ?? 'No summary',
              fixVersion: (info.fixAvailable as string) ?? undefined,
              url: (advisory.url as string) ?? undefined,
              aliases: (advisory.cve as string) ? [advisory.cve as string] : [],
            });
          }
        }
      }

      const metadata = json.metadata as Record<string, unknown> | undefined;
      if (metadata) {
        detailLines = [
          `Total vulnerabilities: ${(metadata.vulnerabilities as string) ?? 'unknown'}`,
          `Total dependencies: ${(metadata.totalDependencies as string) ?? 'unknown'}`,
        ];
      }
    } catch {
      detailLines = ['Failed to parse npm audit JSON output'];
    }
  } else {
    detailLines = [`npm audit exited with code ${result.status}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'npm audit --json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── pip-audit ──────────────────────────────────────────────────────────────

/**
 * Run pip-audit in the given workspace directory.
 * pip-audit supports --requirement, --format json flags.
 */
export async function runPipAudit(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  // Try common requirements files
  const reqFiles = ['requirements.txt', 'requirements-dev.txt'];
  let reqFlag = '';
  for (const f of reqFiles) {
    try {
      await access(join(workspaceRoot, f));
      reqFlag = `--requirement ${f}`;
      break;
    } catch {
      // Try the next conventional requirements filename.
    }
  }

  const args = ['audit', '--format', 'json'];
  if (reqFlag) {
    args.push(...reqFlag.split(' '));
  }

  const result = await runner('pip-audit', args, workspaceRoot);
  return parsePipAuditOutput(result);
}

function parsePipAuditOutput(result: AuditCommandResult): NativeAuditResult {
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0) {
    try {
      const json = JSON.parse(result.stdout || '[]') as Array<Record<string, unknown>>;
      for (const entry of json) {
        advisories.push({
          id: (entry.id as string) ?? (entry.vulnerability_id as string) ?? 'unknown',
          packageName: (entry.name as string) ?? '',
          severity: npmSeverity((entry.severity as string) ?? 'info'),
          summary:
            (entry.description as string) ?? (entry.vulnerability_id as string) ?? 'No summary',
          fixVersion: (entry.fix_version as string) ?? undefined,
          url: (entry.advisory_url as string) ?? undefined,
          aliases: (entry.aliases as string[]) ?? [],
        });
      }
    } catch {
      detailLines = ['Failed to parse pip-audit JSON output'];
    }
  } else {
    detailLines = [`pip-audit exited with code ${result.status}: ${result.stderr}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'pip-audit --format json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── cargo-audit ────────────────────────────────────────────────────────────

/**
 * Run cargo-audit in the given workspace directory.
 */
export async function runCargoAudit(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  const result = await runner('cargo', ['audit', '--json'], workspaceRoot);
  return parseCargoAuditOutput(result);
}

function parseCargoAuditOutput(result: AuditCommandResult): NativeAuditResult {
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0) {
    try {
      const json = JSON.parse(result.stdout || '{}');
      const vulnerabilities = json.vulnerabilities as Record<string, unknown> | undefined;
      const advisoriesList = vulnerabilities?.list as Array<Record<string, unknown>> | undefined;

      if (advisoriesList) {
        for (const adv of advisoriesList) {
          const advisory = adv.advisory as Record<string, unknown> | undefined;
          const pkg = adv.package as Record<string, unknown> | undefined;
          if (!advisory) continue;

          advisories.push({
            id: (advisory.id as string) ?? 'unknown',
            packageName: (pkg?.name as string) ?? '',
            severity: cargoSeverity(((advisory.cvss as string) ?? '').split('/')?.[0] ?? 'info'),
            summary: (advisory.title as string) ?? (advisory.description as string) ?? 'No summary',
            fixVersion: (advisory.patched_versions as string) ?? undefined,
            url: (advisory.url as string) ?? undefined,
            aliases: (advisory.aliases as string[]) ?? [],
          });
        }
      }
    } catch {
      detailLines = ['Failed to parse cargo audit JSON output'];
    }
  } else {
    detailLines = [`cargo audit exited with code ${result.status}: ${result.stderr}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'cargo audit --json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── govulncheck ────────────────────────────────────────────────────────────

/**
 * Run govulncheck in the given workspace directory.
 * Output is JSON with vulnerabilities in the format:
 * { vulns: [{ id, details, osv, ... }] }
 */
export async function runGoVulncheck(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  const result = await runner('govulncheck', ['-json'], workspaceRoot);
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0 || result.status === 3) {
    // govulncheck exits 3 when vulnerabilities found
    try {
      const json = JSON.parse(result.stdout || '{}');
      const vulns = json.vulns as Array<Record<string, unknown>> | undefined;

      if (vulns) {
        for (const v of vulns) {
          const osv = v.osv as string | undefined;

          advisories.push({
            id: (v.id as string) ?? osv ?? 'unknown',
            packageName: (v.package as string) ?? (v.module_path as string) ?? '',
            severity: 'high', // govulncheck doesn't provide CVSS — default to high
            summary: (v.details as string) ?? (v.description as string) ?? osv ?? 'No summary',
            fixVersion: (v.fixed_version as string) ?? undefined,
            url: (v.url as string) ?? undefined,
            aliases: osv ? [osv] : [],
          });
        }
      }
    } catch {
      detailLines = ['Failed to parse govulncheck JSON output'];
    }
  } else if (result.status === 1) {
    detailLines = ['govulncheck: no vulnerabilities found'];
  } else {
    detailLines = [`govulncheck exited with code ${result.status}: ${result.stderr}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'govulncheck -json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── composer audit ─────────────────────────────────────────────────────────

/**
 * Run composer audit in the given workspace directory.
 */
export async function runComposerAudit(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  const result = await runner('composer', ['audit', '--format=json'], workspaceRoot);
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0) {
    try {
      const json = JSON.parse(result.stdout || '{}');
      const advisoriesJson = json.advisories as
        | Record<string, Array<Record<string, unknown>>>
        | undefined;

      if (advisoriesJson) {
        for (const [pkg, advs] of Object.entries(advisoriesJson)) {
          for (const adv of advs) {
            advisories.push({
              id: (adv.cve as string) ?? (adv.reference as string) ?? `composer-${pkg}`,
              packageName: pkg,
              severity: npmSeverity((adv.severity as string) ?? 'medium'),
              summary: (adv.title as string) ?? (adv.description as string) ?? 'No summary',
              fixVersion: adv.link ? (adv.link as string).split('/').pop() : undefined,
              url: (adv.link as string) ?? undefined,
              aliases: (adv.cve as string) ? [adv.cve as string] : [],
            });
          }
        }
      }
    } catch {
      detailLines = ['Failed to parse composer audit JSON output'];
    }
  } else {
    detailLines = [`composer audit exited with code ${result.status}: ${result.stderr}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'composer audit --format=json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── dotnet package audit ───────────────────────────────────────────────────

/**
 * Run `dotnet package audit` in the given workspace directory.
 * .NET 8+ supports `dotnet package audit --format json`.
 */
export async function runDotnetAudit(
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  // Try new --format first, fall back to default output
  const result = await runner('dotnet', ['package', 'audit', '--format', 'json'], workspaceRoot);
  const advisories: NativeAdvisory[] = [];
  let detailLines: string[] = [];

  if (result.status === 0) {
    try {
      const json = JSON.parse(result.stdout || '{}');
      const vulnerabilities = json.vulnerabilities as Record<string, unknown> | undefined;
      const packages = json.packages as Record<string, Array<Record<string, unknown>>> | undefined;

      // Two possible shapes (different .NET SDK versions)
      if (vulnerabilities) {
        // Flat shape: { vulnerabilities: [{ packageName, severity, advisoryUrl, ... }] }
        const vulnList = Array.isArray(vulnerabilities)
          ? (vulnerabilities as Array<Record<string, unknown>>)
          : [];
        for (const v of vulnList) {
          advisories.push({
            id: (v.advisoryId as string) ?? (v.id as string) ?? 'unknown',
            packageName: (v.packageName as string) ?? '',
            severity: npmSeverity((v.severity as string) ?? 'info'),
            summary: (v.description as string) ?? (v.title as string) ?? 'No summary',
            fixVersion: (v.fixedVersion as string) ?? (v.patchedVersion as string) ?? undefined,
            url: (v.advisoryUrl as string) ?? (v.url as string) ?? undefined,
            aliases: (v.aliases as string[]) ?? [],
          });
        }
      } else if (packages) {
        // Nested shape: { packages: { "pkgName": [{ severity, advisoryUrl, ... }] } }
        for (const [pkg, entries] of Object.entries(packages)) {
          for (const entry of entries) {
            advisories.push({
              id: (entry.advisoryId as string) ?? (entry.id as string) ?? 'unknown',
              packageName: pkg,
              severity: npmSeverity((entry.severity as string) ?? 'info'),
              summary: (entry.description as string) ?? (entry.title as string) ?? 'No summary',
              fixVersion:
                (entry.fixedVersion as string) ?? (entry.patchedVersion as string) ?? undefined,
              url: (entry.advisoryUrl as string) ?? (entry.url as string) ?? undefined,
              aliases: (entry.aliases as string[]) ?? [],
            });
          }
        }
      }
    } catch {
      detailLines = ['Failed to parse dotnet package audit JSON output'];
    }
  } else {
    detailLines = [`dotnet package audit exited with code ${result.status}: ${result.stderr}`];
  }

  const evidence: Evidence = {
    kind: 'audit',
    source: 'dotnet package audit --format json',
    retrievedAt: new Date().toISOString(),
    detail: detailLines.join('\n') || `Found ${advisories.length} advisories`,
  };

  return { advisories, evidence };
}

// ── Common command runner ──────────────────────────────────────────────────

export interface AuditCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type AuditCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => AuditCommandResult | Promise<AuditCommandResult>;

const defaultAuditCommandRunner: AuditCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<AuditCommandResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        // On Windows the audit tools are batch shims — `npm`/`composer` resolve
        // to npm.cmd/composer.cmd, which execFile cannot launch without a shell
        // (it ignores PATHEXT), so it fails ENOENT and every Windows audit
        // silently reports "exited with code null" with zero advisories. Route
        // through the shell there. Safe because every command and argument here
        // is a static literal (conventional filenames only) — no user input
        // reaches the command line; the dynamic workspace path is passed as cwd.
        shell: process.platform === 'win32',
      },
      (error, stdout, stderr) => {
        const exitCode = (error as (Error & { code?: string | number }) | null)?.code;
        const status = error ? (typeof exitCode === 'number' ? exitCode : null) : 0;
        resolve({
          status,
          stdout,
          stderr: stderr || (status === null && error ? error.message : ''),
        });
      },
    );
  });

// ── Ecosystem dispatch ─────────────────────────────────────────────────────

/**
 * Run the native audit command for the given ecosystem.
 * Returns advisories found by the native tool.
 */
export async function runNativeAudit(
  ecosystem: EcosystemId,
  workspaceRoot: string,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<NativeAuditResult> {
  switch (ecosystem) {
    case 'npm':
      return runNpmAudit(workspaceRoot, runner);
    case 'python':
      return runPipAudit(workspaceRoot, runner);
    case 'rust':
      return runCargoAudit(workspaceRoot, runner);
    case 'go':
      return runGoVulncheck(workspaceRoot, runner);
    case 'php':
      return runComposerAudit(workspaceRoot, runner);
    case 'dotnet':
      return runDotnetAudit(workspaceRoot, runner);
    // dart/pub doesn't have a standard audit command — use OSV instead
    default:
      return {
        advisories: [],
        evidence: {
          kind: 'audit',
          source: `native-audit:${ecosystem}`,
          retrievedAt: new Date().toISOString(),
          detail: `No native audit tool for ecosystem: ${ecosystem}`,
        },
      };
  }
}

// ── Availability check ─────────────────────────────────────────────────────

/**
 * Check if the native audit tool is available for the given ecosystem.
 */
export async function isNativeAuditAvailable(
  ecosystem: EcosystemId,
  runner: AuditCommandRunner = defaultAuditCommandRunner,
): Promise<boolean> {
  const result = await runner(
    ecosystem === 'npm'
      ? 'npm'
      : ecosystem === 'python'
        ? 'pip-audit'
        : ecosystem === 'rust'
          ? 'cargo'
          : ecosystem === 'go'
            ? 'govulncheck'
            : ecosystem === 'php'
              ? 'composer'
              : ecosystem === 'dotnet'
                ? 'dotnet'
                : '',
    ['--version'],
    process.cwd(),
  );

  return result.status === 0;
}

export interface ConfiguredAuditRunner {
  run(ecosystem: EcosystemId, workspaceRoot: string): Promise<NativeAuditResult>;
  isAvailable(ecosystem: EcosystemId, cwd?: string): Promise<boolean>;
}

/** Build a hermetic native-audit dispatcher around an injected command strategy. */
export function createAuditRunner(
  commandRunner: AuditCommandRunner = defaultAuditCommandRunner,
): ConfiguredAuditRunner {
  const commandFor = (ecosystem: EcosystemId): string | undefined => {
    switch (ecosystem) {
      case 'npm':
        return 'npm';
      case 'python':
        return 'pip-audit';
      case 'rust':
        return 'cargo';
      case 'go':
        return 'govulncheck';
      case 'php':
        return 'composer';
      case 'dotnet':
        return 'dotnet';
      default:
        return undefined;
    }
  };
  return {
    run: (ecosystem, workspaceRoot) => runNativeAudit(ecosystem, workspaceRoot, commandRunner),
    isAvailable: async (ecosystem, cwd = process.cwd()) => {
      const command = commandFor(ecosystem);
      return command ? (await commandRunner(command, ['--version'], cwd)).status === 0 : false;
    },
  };
}
