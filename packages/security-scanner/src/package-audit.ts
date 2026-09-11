import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWin32CmdShimInvocation } from '@wrongstack/core/utils';

export type AuditablePackageManager = 'npm' | 'pnpm';
export type PackageAuditSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info' | 'unknown';

export interface PackageAuditVulnerability {
  name: string;
  severity: PackageAuditSeverity;
  isDirect?: boolean | undefined;
  range?: string | undefined;
  via: string[];
  fixAvailable: boolean;
}

export interface PackageAuditSummary {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  total: number;
}

export interface PackageAuditResult {
  packageManager?: AuditablePackageManager | undefined;
  command?: string | undefined;
  vulnerabilities: PackageAuditVulnerability[];
  summary: PackageAuditSummary;
  exitCode: number | null;
  success: boolean;
  skipped: boolean;
  error?: string | undefined;
}

export interface PackageAuditExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error | undefined;
}

export type PackageAuditExecutor = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<PackageAuditExecutionResult>;

const EMPTY_SUMMARY: PackageAuditSummary = {
  critical: 0,
  high: 0,
  moderate: 0,
  low: 0,
  info: 0,
  total: 0,
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectAuditablePackageManager(
  projectRoot: string,
): Promise<AuditablePackageManager | null> {
  if (await exists(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(projectRoot, 'package-lock.json'))) return 'npm';
  return null;
}

const defaultExecutor: PackageAuditExecutor = (command, args, cwd) =>
  new Promise((resolve) => {
    // `npm`/`pnpm` are `.cmd` shims on Windows, which Node refuses to exec
    // directly (CVE-2024-27980). Route through the canonical cmd-shim builder
    // rather than `shell: true`: it quotes every token and refuses arguments
    // carrying shell metacharacters, so the `.cmd` wrapper cannot be used to
    // chain a second command. See S4 in shell-true-parity.test.ts.
    let executable = command;
    let execArgs: readonly string[] = args;
    let windowsVerbatimArguments: true | undefined;
    if (process.platform === 'win32') {
      try {
        const shim = buildWin32CmdShimInvocation(command, args);
        executable = shim.command;
        execArgs = shim.args;
        windowsVerbatimArguments = shim.windowsVerbatimArguments;
      } catch (error) {
        resolve({ stdout: '', stderr: '', exitCode: null, error: error as Error });
        return;
      }
    }
    try {
      execFile(
        executable,
        [...execArgs],
        {
          cwd,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
        },
        (error, stdout, stderr) => {
          const errorWithCode = error as (Error & { code?: string | number | undefined }) | null;
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: typeof errorWithCode?.code === 'number' ? errorWithCode.code : error ? null : 0,
            error: error ?? undefined,
          });
        },
      );
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error as Error,
      });
    }
  });

function normalizeSeverity(value: unknown): PackageAuditSeverity {
  return value === 'critical' ||
    value === 'high' ||
    value === 'moderate' ||
    value === 'low' ||
    value === 'info'
    ? value
    : 'unknown';
}

function parseVia(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry === 'object' && entry !== null) {
      const title = (entry as Record<string, unknown>).title;
      const source = (entry as Record<string, unknown>).source;
      if (typeof title === 'string') return [title];
      if (typeof source === 'number' || typeof source === 'string') return [String(source)];
    }
    return [];
  });
}

function numberField(record: Record<string, unknown>, key: keyof PackageAuditSummary): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parsePackageAuditOutput(output: string): {
  vulnerabilities: PackageAuditVulnerability[];
  summary: PackageAuditSummary;
} {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('Audit output is not a JSON object');
  const root = parsed as Record<string, unknown>;
  if (root.error) {
    const auditError = root.error;
    if (typeof auditError === 'string') throw new Error(auditError);
    if (typeof auditError === 'object' && auditError !== null) {
      const errorRecord = auditError as Record<string, unknown>;
      const message = errorRecord.summary ?? errorRecord.message ?? errorRecord.code;
      throw new Error(typeof message === 'string' ? message : 'Package audit reported an error');
    }
    throw new Error('Package audit reported an error');
  }
  const vulnerabilityRecord =
    typeof root.vulnerabilities === 'object' && root.vulnerabilities !== null
      ? (root.vulnerabilities as Record<string, unknown>)
      : {};
  const vulnerabilities: PackageAuditVulnerability[] = Object.entries(vulnerabilityRecord).flatMap(
    ([name, raw]) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const vulnerability = raw as Record<string, unknown>;
      return [
        {
          name,
          severity: normalizeSeverity(vulnerability.severity),
          isDirect:
            typeof vulnerability.isDirect === 'boolean' ? vulnerability.isDirect : undefined,
          range: typeof vulnerability.range === 'string' ? vulnerability.range : undefined,
          via: parseVia(vulnerability.via),
          fixAvailable: Boolean(vulnerability.fixAvailable),
        },
      ];
    },
  );
  const advisoryRecord =
    typeof root.advisories === 'object' && root.advisories !== null
      ? (root.advisories as Record<string, unknown>)
      : {};
  if (vulnerabilities.length === 0) {
    for (const [id, raw] of Object.entries(advisoryRecord)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const advisory = raw as Record<string, unknown>;
      vulnerabilities.push({
        name: typeof advisory.module_name === 'string' ? advisory.module_name : id,
        severity: normalizeSeverity(advisory.severity),
        range:
          typeof advisory.vulnerable_versions === 'string'
            ? advisory.vulnerable_versions
            : undefined,
        via: typeof advisory.title === 'string' ? [advisory.title] : [],
        fixAvailable: false,
      });
    }
  }

  const metadata =
    typeof root.metadata === 'object' && root.metadata !== null
      ? (root.metadata as Record<string, unknown>)
      : {};
  const rawSummary =
    typeof metadata.vulnerabilities === 'object' && metadata.vulnerabilities !== null
      ? (metadata.vulnerabilities as Record<string, unknown>)
      : {};
  const summary: PackageAuditSummary = {
    critical: numberField(rawSummary, 'critical'),
    high: numberField(rawSummary, 'high'),
    moderate: numberField(rawSummary, 'moderate'),
    low: numberField(rawSummary, 'low'),
    info: numberField(rawSummary, 'info'),
    total: numberField(rawSummary, 'total'),
  };

  const summarizedTotal =
    summary.critical + summary.high + summary.moderate + summary.low + summary.info;
  if (summary.total === 0 && summarizedTotal > 0) {
    summary.total = summarizedTotal;
  } else if (summary.total === 0 && vulnerabilities.length > 0) {
    for (const vulnerability of vulnerabilities) {
      if (vulnerability.severity !== 'unknown') summary[vulnerability.severity]++;
    }
    summary.total = vulnerabilities.length;
  }
  return { vulnerabilities, summary };
}

export class PackageAuditRunner {
  constructor(private readonly executor: PackageAuditExecutor = defaultExecutor) {}

  async run(projectRoot: string): Promise<PackageAuditResult> {
    const packageManager = await detectAuditablePackageManager(projectRoot);
    if (!packageManager) {
      return {
        vulnerabilities: [],
        summary: { ...EMPTY_SUMMARY },
        exitCode: null,
        success: false,
        skipped: true,
        error: 'No pnpm-lock.yaml or package-lock.json was found',
      };
    }

    const args = ['audit', '--json'];
    try {
      const execution = await this.executor(packageManager, args, projectRoot);
      try {
        const parsed = parsePackageAuditOutput(execution.stdout);
        return {
          packageManager,
          command: `${packageManager} audit --json`,
          ...parsed,
          exitCode: execution.exitCode,
          success: true,
          skipped: false,
        };
      } catch (error) {
        const parseError = (error as Error).message;
        return {
          packageManager,
          command: `${packageManager} audit --json`,
          vulnerabilities: [],
          summary: { ...EMPTY_SUMMARY },
          exitCode: execution.exitCode,
          success: false,
          skipped: false,
          error: execution.stderr.trim() || execution.error?.message || parseError,
        };
      }
    } catch (error) {
      return {
        packageManager,
        command: `${packageManager} audit --json`,
        vulnerabilities: [],
        summary: { ...EMPTY_SUMMARY },
        exitCode: null,
        success: false,
        skipped: false,
        error: (error as Error).message,
      };
    }
  }
}

export const defaultPackageAuditRunner = new PackageAuditRunner();
