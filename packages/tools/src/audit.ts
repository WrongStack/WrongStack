import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { spawnStream } from './_spawn-stream.js';
import {
  commandOutputPreviewBytes,
  detectPackageManager,
  normalizeCommandOutput,
  safeResolveReal,
} from './_util.js';
import { tryLegacyPackageOperation } from './languages/legacy-bridge.js';

export interface AuditInput {
  cwd?: string | undefined;
  level?: 'low' | 'moderate' | 'high' | 'critical' | undefined;
  fix?: boolean | undefined;
}

export interface AuditVulnerability {
  severity: string;
  package: string;
  title: string;
  url: string;
}

export interface AuditOutput {
  exit_code: number;
  vulnerabilities: AuditVulnerability[];
  total: number;
  summary: string;
  output: string;
  truncated: boolean;
}

export type AuditContext = Parameters<Tool<AuditInput, AuditOutput>['execute']>[1];

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export const auditTool = {
  name: 'audit',
  category: 'Package Management',
  description:
    'Run a security audit against project dependencies (using pnpm/npm audit). Reports known vulnerabilities with severity.',
  usageHint:
    'CRITICAL SECURITY TOOL:\n\n' +
    '- Run regularly and especially before any release.\n' +
    '- Use `level` to focus on high/critical issues.\n' +
    '- This tool is read-only: to remediate, use `install` (or `language_package`) to upgrade the affected packages.\n' +
    'This is one of the most important tools for supply chain security.',
  permission: 'confirm',
  mutating: false,
  capabilities: ['shell.restricted'],
  icon: 'package',
  timeoutMs: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      level: {
        type: 'string',
        enum: ['low', 'moderate', 'high', 'critical'],
        description: 'Minimum severity level to report',
      },
      fix: {
        type: 'boolean',
        description:
          'Deprecated and rejected — this tool is read-only and never modifies dependencies. Use `install` (or `language_package`) to remediate vulnerabilities.',
      },
    },
  },
  async execute(input: AuditInput, ctx: AuditContext, opts?: { signal: AbortSignal }) {
    let final: AuditOutput | undefined;
    const executeStream = auditTool.executeStream;
    if (!executeStream) throw new Error('auditTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('audit: stream ended without final event');
    return final;
  },
  async *executeStream(
    input: AuditInput,
    ctx: AuditContext,
    opts?: { signal: AbortSignal },
  ): AsyncGenerator<ToolStreamEvent<AuditOutput>> {
    // `audit` is declared `mutating: false` — silently forwarding `--fix`
    // would rewrite package.json/lockfile behind the permission gate.
    if (input.fix === true) {
      throw new ToolValidationError({
        message:
          'audit: `fix: true` is not supported — this tool is read-only (mutating: false). ' +
          'To remediate vulnerabilities, upgrade the affected packages with the `install` tool ' +
          '(or `language_package` for non-JS ecosystems).',
        field: 'fix',
      });
    }

    const VALID_LEVELS: ReadonlySet<string> = new Set(['low', 'moderate', 'high', 'critical']);
    if (input.level !== undefined && !VALID_LEVELS.has(input.level)) {
      throw new ToolValidationError({
        message: `audit: invalid severity level "${input.level}". Allowed: low, moderate, high, critical`,
        field: 'level',
      });
    }

    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    const bridge = await tryLegacyPackageOperation('package-audit', {
      cwd,
      projectRoot: ctx.projectRoot,
      signal,
    });
    if (bridge?.outcome) {
      const outcome = bridge.outcome;
      // An audit that never ran must not read as "No vulnerabilities found".
      if (
        outcome.status === 'unavailable' ||
        outcome.status === 'cancelled' ||
        outcome.status === 'timed_out'
      ) {
        throw new Error(
          `audit: ${bridge.language} audit did not run (${outcome.status})` +
            `${outcome.run?.error ? `: ${outcome.run.error}` : ''}`,
        );
      }
      const vulns = outcome.vulnerabilities.map((v) => ({
        severity: v.severity,
        package: v.package,
        title: v.advisory ?? 'Unknown vulnerability',
        url: v.url ?? '',
      }));
      const total = vulns.length;
      const summary =
        total === 0
          ? 'No vulnerabilities found'
          : `Found ${total} vulnerabilities: ${vulns.filter((a) => a.severity === 'critical').length} critical, ${vulns.filter((a) => a.severity === 'high').length} high`;
      yield {
        type: 'final',
        output: {
          exit_code: outcome.run?.exitCode ?? 0,
          vulnerabilities: vulns,
          total,
          summary,
          output: outcome.run?.output ?? '',
          truncated: outcome.run?.truncated ?? false,
        },
      };
      return;
    }

    const manager = await detectPackageManager(cwd, ctx.projectRoot);
    yield { type: 'log', text: `Auditing with ${manager}…`, data: { manager } };

    const args = ['audit', '--json'];
    // npm and pnpm both accept --audit-level; yarn classic does not, so for
    // yarn the parsed results are filtered by severity instead (parseAuditOutput
    // applies the filter for every manager as a belt-and-braces guarantee).
    if (input.level && (manager === 'npm' || manager === 'pnpm')) {
      args.push(`--audit-level=${input.level}`);
    }

    const result = yield* spawnStream({
      cmd: manager,
      args,
      cwd,
      signal,
      maxBytes: 100_000,
    });

    yield {
      type: 'final',
      output: parseAuditOutput(result.stdout, result.exitCode, {
        level: input.level,
        spawnTruncated: result.truncated,
        rawError: result.stderr || result.error || '',
      }),
    };
  },
} satisfies Tool<AuditInput, AuditOutput>;

function parseAuditOutput(
  json: string,
  exitCode: number,
  opts: { level?: AuditInput['level']; spawnTruncated?: boolean; rawError?: string } = {},
): AuditOutput {
  if (!json) {
    // No report at all plus a non-zero exit means the audit itself failed
    // (package manager missing, crashed, …) — throw rather than return an
    // empty "0 vulnerabilities" result the executor would record as success.
    if (exitCode !== 0) {
      const detail = normalizeCommandOutput(opts.rawError || '').trim();
      throw new Error(
        `audit: the audit command failed (exit ${exitCode}) without producing a report` +
          `${detail ? `: ${detail}` : ''}`,
      );
    }
    return {
      exit_code: exitCode,
      vulnerabilities: [],
      total: 0,
      summary: 'No vulnerabilities found',
      output: '',
      truncated: false,
    };
  }

  const cappedOutput = normalizeCommandOutput(json);
  const truncated =
    opts.spawnTruncated === true || Buffer.byteLength(json, 'utf8') > commandOutputPreviewBytes();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    // yarn classic streams NDJSON (`auditAdvisory` lines + an `auditSummary`),
    // which no single JSON.parse accepts.
    const yarn = extractYarnClassicAdvisories(json);
    if (yarn) data = { advisories: yarn };
    else
      return {
        exit_code: exitCode,
        vulnerabilities: [],
        total: 0,
        summary: 'Could not parse audit output',
        output: cappedOutput,
        truncated,
      };
  }

  let advisories = extractAdvisories(data);

  // Minimum-severity filter. npm/pnpm already honor --audit-level on the
  // process side, but the JSON they emit can still include lower-severity
  // entries (npm's --audit-level only gates the exit code), so filter here.
  const minRank = opts.level ? (SEVERITY_RANK[opts.level] ?? 0) : 0;
  if (minRank > 0) {
    advisories = advisories.filter((a) => (SEVERITY_RANK[a.severity] ?? 0) >= minRank);
  }

  const total = advisories.length;
  let summary: string;
  if (total === 0) {
    if (exitCode !== 0) {
      const errObj = data['error'] as Record<string, unknown> | undefined;
      // npm/pnpm report their own failures (no lockfile, registry error, …)
      // as a JSON `error` object: the audit did not run, so throw.
      if (errObj && typeof errObj === 'object') {
        const reason =
          typeof errObj['summary'] === 'string'
            ? errObj['summary']
            : typeof errObj['code'] === 'string'
              ? errObj['code']
              : 'unknown error';
        throw new Error(`audit: the audit command failed (exit ${exitCode}): ${reason}`);
      }
      summary = 'Audit failed';
    } else {
      summary = 'No vulnerabilities found';
    }
  } else {
    summary = `Found ${total} vulnerabilities: ${advisories.filter((a) => a.severity === 'critical').length} critical, ${advisories.filter((a) => a.severity === 'high').length} high`;
  }

  return {
    exit_code: exitCode,
    vulnerabilities: advisories,
    total,
    summary,
    output: cappedOutput,
    truncated,
  };
}

/**
 * Normalize the three audit JSON shapes into one advisory list:
 * - npm ≤6 and pnpm: `{ advisories: { <id>: { severity, module_name, title, url } } }`
 * - npm ≥7: `{ vulnerabilities: { <pkg>: { severity, via: [...] } }, metadata: {...} }`
 */
/**
 * yarn classic NDJSON → the npm v6 `advisories` map. yarn emits one
 * `auditAdvisory` line per (advisory, dependency path), so lines are keyed by
 * advisory id. Null when the stream holds no yarn audit records at all.
 */
function extractYarnClassicAdvisories(text: string): Record<string, unknown> | null {
  const advisories: Record<string, unknown> = {};
  let sawAudit = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: { type?: unknown; data?: { advisory?: Record<string, unknown> } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record?.type === 'auditSummary') sawAudit = true;
    if (record?.type !== 'auditAdvisory') continue;
    sawAudit = true;
    const advisory = record.data?.advisory;
    if (!advisory || typeof advisory !== 'object') continue;
    advisories[String(advisory['id'] ?? Object.keys(advisories).length)] = advisory;
  }
  return sawAudit ? advisories : null;
}

function extractAdvisories(data: Record<string, unknown>): AuditVulnerability[] {
  const advisories: AuditVulnerability[] = [];

  // npm v6 / pnpm shape.
  const ads = data['advisories'];
  if (ads && typeof ads === 'object') {
    for (const [id, value] of Object.entries(ads as Record<string, unknown>)) {
      const adv = (value ?? {}) as Record<string, unknown>;
      advisories.push({
        severity: typeof adv['severity'] === 'string' ? (adv['severity'] as string) : 'unknown',
        package: typeof adv['module_name'] === 'string' ? (adv['module_name'] as string) : id,
        title:
          typeof adv['title'] === 'string' ? (adv['title'] as string) : 'Unknown vulnerability',
        url: typeof adv['url'] === 'string' ? (adv['url'] as string) : '',
      });
    }
    return advisories;
  }

  // npm v7+ shape: `vulnerabilities` keyed by package name. Advisory details
  // (title/url) live in the `via` array's object entries; string entries are
  // just transitive package-name references.
  const vulns = data['vulnerabilities'];
  if (vulns && typeof vulns === 'object') {
    for (const [pkg, value] of Object.entries(vulns as Record<string, unknown>)) {
      const vuln = (value ?? {}) as Record<string, unknown>;
      const via = Array.isArray(vuln['via']) ? (vuln['via'] as unknown[]) : [];
      const details = via.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      if (details.length > 0) {
        for (const detail of details) {
          advisories.push({
            severity:
              typeof detail['severity'] === 'string'
                ? (detail['severity'] as string)
                : typeof vuln['severity'] === 'string'
                  ? (vuln['severity'] as string)
                  : 'unknown',
            package: pkg,
            title:
              typeof detail['title'] === 'string'
                ? (detail['title'] as string)
                : 'Unknown vulnerability',
            url: typeof detail['url'] === 'string' ? (detail['url'] as string) : '',
          });
        }
      } else {
        advisories.push({
          severity: typeof vuln['severity'] === 'string' ? (vuln['severity'] as string) : 'unknown',
          package: pkg,
          title: 'Unknown vulnerability',
          url: '',
        });
      }
    }
  }

  return advisories;
}
