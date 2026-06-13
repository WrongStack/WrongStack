import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { detectPackageManager, safeResolve } from './_util.js';

interface AuditInput {
  cwd?: string | undefined;
  level?: 'low' | 'moderate' | 'high' | 'critical' | undefined;
  fix?: boolean | undefined;
  packages?: string | string[] | undefined;
}

interface AuditVulnerability {
  severity: string;
  package: string;
  title: string;
  url: string;
}

interface AuditOutput {
  exit_code: number;
  vulnerabilities: AuditVulnerability[];
  total: number;
  summary: string;
  output: string;
  truncated: boolean;
}

export const auditTool: Tool<AuditInput, AuditOutput> = {
  name: 'audit',
  category: 'Package Management',
  description:
    'Run a security audit against project dependencies (using pnpm/npm audit). Reports known vulnerabilities with severity.',
  usageHint:
    'CRITICAL SECURITY TOOL:\n\n' +
    '- Run regularly and especially before any release.\n' +
    '- Use `level` to focus on high/critical issues.\n' +
    '- `fix` can attempt automatic remediation for some vulnerabilities.\n' +
    'This is one of the most important tools for supply chain security.',
  permission: 'confirm',
  mutating: false,
  capabilities: ['shell.restricted'],
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
      fix: { type: 'boolean', description: 'Attempt to fix vulnerabilities (default: false)' },
      packages: { type: 'string', description: 'Specific package(s) to audit (comma-separated)' },
    },
  },
  async execute(input, ctx, opts) {
    let final: AuditOutput | undefined;
    const executeStream = auditTool.executeStream;
    if (!executeStream) throw new Error('auditTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('audit: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<AuditOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const manager = await detectPackageManager(cwd);
    yield { type: 'log', text: `Auditing with ${manager}…`, data: { manager } };

    const args = ['audit', '--json'];
    if (input.fix) args.push('--fix');
    if (input.packages) {
      const pkgs = Array.isArray(input.packages) ? input.packages : input.packages.split(',');
      args.push(...pkgs.map((p: string) => p.trim()));
    }

    const result = yield* spawnStream({
      cmd: manager,
      args,
      cwd,
      signal: opts.signal,
      maxBytes: 100_000,
    });

    yield { type: 'final', output: parseAuditOutput(result.stdout, result.exitCode) };
  },
};

function parseAuditOutput(json: string, exitCode: number): AuditOutput {
  if (!json) {
    return {
      exit_code: exitCode,
      vulnerabilities: [],
      total: 0,
      summary: exitCode === 0 ? 'No vulnerabilities found' : 'Audit failed',
      output: '',
      truncated: false,
    };
  }

  try {
    const data = JSON.parse(json);
    const advisories: AuditVulnerability[] = [];
    const ads = data.advisories ?? {};
    for (const id of Object.keys(ads)) {
      const adv = ads[id];
      advisories.push({
        severity: adv.severity ?? 'unknown',
        package: adv.module_name ?? id,
        title: adv.title ?? 'Unknown vulnerability',
        url: adv.url ?? '',
      });
    }

    const total = advisories.length;
    const summary =
      total === 0
        ? 'No vulnerabilities found'
        : `Found ${total} vulnerabilities: ${advisories.filter((a) => a.severity === 'critical').length} critical, ${advisories.filter((a) => a.severity === 'high').length} high`;

    return {
      exit_code: exitCode,
      vulnerabilities: advisories,
      total,
      summary,
      output: json,
      truncated: json.length >= 100_000,
    };
  } catch {
    return {
      exit_code: exitCode,
      vulnerabilities: [],
      total: 0,
      summary: 'Could not parse audit output',
      output: json,
      truncated: false,
    };
  }
}
