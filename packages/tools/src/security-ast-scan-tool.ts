/**
 * `security-ast-scan` tool — Contract-based Security & Performance AST Radar.
 *
 * Scans code files or snippets for anti-patterns that static types cannot catch:
 * 1. N+1 Database Query loops (Performance critical)
 * 2. SQL Injection / Raw query interpolation (Security critical)
 * 3. Hardcoded secrets, API tokens, and private keys
 * 4. Prototype Pollution vulnerabilities
 * 5. ReDoS (Regular Expression Denial of Service) nested backtracking
 * 6. Unsafe dynamic execution (eval, new Function, unsanitized child_process.exec)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveProjectPath } from './_util.js';

export interface SecurityFinding {
  ruleId:
    | 'perf/n-plus-one-query'
    | 'sec/sql-injection'
    | 'sec/hardcoded-secret'
    | 'sec/prototype-pollution'
    | 'sec/redos-vulnerable-regex'
    | 'sec/unsafe-dynamic-exec';
  category: 'security' | 'performance';
  severity: 'critical' | 'warning' | 'info';
  file: string;
  line: number;
  message: string;
  snippet: string;
  recommendation: string;
}

export interface SecurityScanInput {
  /** File path to scan (relative to project root or absolute). */
  file?: string | undefined;
  /** Direct code content to scan (optional, if scanning unwritten draft). */
  content?: string | undefined;
  /** Specific rule IDs to enable or filter by. */
  rules?: string[] | undefined;
}

export interface SecurityScanOutput {
  status: 'clean' | 'findings_detected' | 'error';
  filesScanned: number;
  totalFindings: number;
  criticalCount: number;
  warningCount: number;
  findings: SecurityFinding[];
  summary: string;
  error?: string | undefined;
}

// ─── Secret & Token Patterns ────────────────────────────────────────────────
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'AWS Access Key', regex: /\b(AKIA[0-9A-Z]{16})\b/ },
  { name: 'GitHub Token', regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/ },
  { name: 'Stripe Secret Key', regex: /\b(sk_live_[0-9a-zA-Z]{24,})\b/ },
  { name: 'Slack Token', regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/ },
  { name: 'Private Key Header', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
];

// ─── ReDoS Vulnerable Regex Patterns ─────────────────────────────────────────
const REDOS_PATTERNS = [
  /\([^)]+[+*]\)[+*]/,
  /\([a-zA-Z0-9_.\\-]+\+?\)\+/i,
  /\([a-zA-Z0-9_.\\-]+\*?\)\*/i,
];

// ─── DB Query Call Patterns ──────────────────────────────────────────────────
const DB_QUERY_CALL_REGEX =
  /(?:db|prisma|sequelize|knex|typeorm|connection|pool|repo|repository|client)\.(?:query|execute|raw|find|findAll|findOne|findMany|create|update|delete|save|insert|select)\s*\(/i;

const SQL_INTERPOLATION_REGEX = /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN).*\$\{[^}]+\}/i;

const RAW_SQL_CONCAT_REGEX = /(?:SELECT|INSERT|UPDATE|DELETE).+['"]\s*\+\s*[a-zA-Z0-9_]/i;

export function analyzeSecurityAndPerformance(
  filePath: string,
  content: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');
  const relPath = filePath.replace(/\\/g, '/');

  // Skip test fixtures and mock data from secret scans
  const isTestFile = /(?:test|spec|mock|fixture)[s]?[/\\._]/i.test(relPath);

  // 1. Secret & Key Scanning
  if (!isTestFile) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const secretRule of SECRET_PATTERNS) {
        if (secretRule.regex.test(line)) {
          findings.push({
            ruleId: 'sec/hardcoded-secret',
            category: 'security',
            severity: 'critical',
            file: relPath,
            line: i + 1,
            message: `Hardcoded ${secretRule.name} detected.`,
            snippet: line.trim(),
            recommendation:
              'Store sensitive keys and credentials in environment variables or a secret vault.',
          });
        }
      }
    }
  }

  // 2. Prototype Pollution
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (
      line.includes('__proto__') ||
      line.includes('constructor.prototype') ||
      /\bObject\.assign\s*\(\s*\{\}\s*,\s*req\.body\b/.test(line)
    ) {
      findings.push({
        ruleId: 'sec/prototype-pollution',
        category: 'security',
        severity: 'warning',
        file: relPath,
        line: i + 1,
        message: 'Potential prototype pollution vulnerability on object mutation.',
        snippet: line.trim(),
        recommendation:
          'Validate input keys, use `Object.create(null)` for map dictionaries, or use secure deep-merge utilities.',
      });
    }
  }

  // 3. Unsafe Dynamic Execution (eval, new Function, unsanitized exec)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (
      /\beval\s*\(/.test(line) ||
      /\bnew\s+Function\s*\(/.test(line) ||
      /(?:exec|execSync)\s*\(\s*`[^`]*\$\{/.test(line)
    ) {
      findings.push({
        ruleId: 'sec/unsafe-dynamic-exec',
        category: 'security',
        severity: 'critical',
        file: relPath,
        line: i + 1,
        message: 'Unsafe dynamic code execution with variable template interpolation.',
        snippet: line.trim(),
        recommendation:
          'Use static function dispatch or `spawnFile`/`execFile` with an explicit argument array rather than passing raw shell strings.',
      });
    }
  }

  // 4. SQL Injection / Raw Query Interpolation
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (SQL_INTERPOLATION_REGEX.test(line) || RAW_SQL_CONCAT_REGEX.test(line)) {
      findings.push({
        ruleId: 'sec/sql-injection',
        category: 'security',
        severity: 'critical',
        file: relPath,
        line: i + 1,
        message:
          'Raw SQL query constructed via string concatenation or template literal interpolation.',
        snippet: line.trim(),
        recommendation:
          'Use parameterized queries ($1, ?), prepared statements, or ORM query builder methods.',
      });
    }
  }

  // 5. ReDoS (Nested Quantifiers)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes('RegExp') || line.includes('/')) {
      for (const redosPat of REDOS_PATTERNS) {
        if (redosPat.test(line)) {
          findings.push({
            ruleId: 'sec/redos-vulnerable-regex',
            category: 'security',
            severity: 'warning',
            file: relPath,
            line: i + 1,
            message:
              'Regular expression contains nested quantifiers prone to catastrophic backtracking (ReDoS).',
            snippet: line.trim(),
            recommendation:
              'Refactor regular expression to avoid nested repetitions like `(a+)+` or `(x*)*`.',
          });
          break;
        }
      }
    }
  }

  // 6. N+1 Database Query in Loops
  // Simple heuristic & AST block tracking: when inside a loop block, detect DB calls
  let inLoopDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (
      /\b(?:for\s*\(|while\s*\(|for\s+await|\.forEach\s*\(|\.map\s*\(\s*(?:async\s*)?\()/.test(
        trimmed,
      )
    ) {
      inLoopDepth++;
    }

    if (inLoopDepth > 0 && DB_QUERY_CALL_REGEX.test(trimmed)) {
      findings.push({
        ruleId: 'perf/n-plus-one-query',
        category: 'performance',
        severity: 'critical',
        file: relPath,
        line: i + 1,
        message: 'Database query executed inside a loop (N+1 query anti-pattern).',
        snippet: trimmed,
        recommendation:
          'Batch query data using `IN (...)` or fetch relationships eagerly before the loop.',
      });
    }

    if (trimmed.includes('}') || (trimmed.endsWith(');') && inLoopDepth > 0)) {
      inLoopDepth = Math.max(0, inLoopDepth - 1);
    }
  }

  return findings;
}

export const securityAstScanTool: Tool<SecurityScanInput, SecurityScanOutput> = {
  name: 'security-ast-scan',
  category: 'Code Quality',
  icon: 'code',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  description:
    'Scan source code for contract-based security vulnerabilities and performance bottlenecks ' +
    '(N+1 SQL queries, SQL injection, hardcoded secrets, prototype pollution, ReDoS, and unsafe eval).',
  usageHint:
    'RUN AFTER WRITING OR REFACTORING CODE TO CATCH HIDDEN DEFECTS:\n\n' +
    '- Pass `file: "src/user-service.ts"` or direct `content: "..."`.\n' +
    '- Catches N+1 loops, hardcoded secrets, SQL injection, and prototype pollution before committing.\n' +
    '- Returns severity-ranked findings with line numbers and exact remediation recommendations.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File path to scan (relative to project root).',
      },
      content: {
        type: 'string',
        description: 'Direct code string to scan without writing to disk.',
      },
      rules: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of rule IDs to filter by.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
      let targetFile = input.file ?? 'inline-code.ts';
      let content = input.content;

      if (!content && input.file) {
        // H-6 (security report VF-06): same fix as codebase-skeleton — this
        // tool is `permission: 'auto'`, so a bare isAbsolute passthrough read
        // arbitrary files (and echoed matched secret lines verbatim) without
        // a prompt. safeResolveProjectPath preserves the schema-documented
        // "relative to project root" contract while enforcing containment.
        const absPath = await safeResolveProjectPath(input.file, ctx);
        targetFile = path.relative(projectRoot, absPath).replace(/\\/g, '/');
        content = await fs.readFile(absPath, 'utf8');
      }

      if (!content) {
        return {
          status: 'clean',
          filesScanned: 0,
          totalFindings: 0,
          criticalCount: 0,
          warningCount: 0,
          findings: [],
          summary: 'No content or file provided to scan.',
        };
      }

      let findings = analyzeSecurityAndPerformance(targetFile, content);

      if (input.rules && input.rules.length > 0) {
        const ruleSet = new Set(input.rules);
        findings = findings.filter((f) => ruleSet.has(f.ruleId));
      }

      const criticalCount = findings.filter((f) => f.severity === 'critical').length;
      const warningCount = findings.filter((f) => f.severity === 'warning').length;
      const totalFindings = findings.length;

      const status = totalFindings === 0 ? 'clean' : 'findings_detected';
      const summary =
        totalFindings === 0
          ? `Security & Performance AST Scan: CLEAN (${targetFile})`
          : `Security & Performance AST Scan: ${totalFindings} issue(s) detected (${criticalCount} critical, ${warningCount} warning).`;

      return {
        status,
        filesScanned: 1,
        totalFindings,
        criticalCount,
        warningCount,
        findings,
        summary,
      };
    } catch (err) {
      return {
        status: 'error',
        filesScanned: 0,
        totalFindings: 0,
        criticalCount: 0,
        warningCount: 0,
        findings: [],
        summary: '',
        error: toErrorMessage(err),
      };
    }
  },
};
