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
 *
 * Rules 2-6 are JavaScript/TypeScript line heuristics. Other languages with a
 * profile (see security-scan-languages.ts) run that profile's rules, and every
 * other language only gets the language-agnostic secret scan: a result with no
 * findings there says so (`unsupported_language`) instead of reporting `clean`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { safeResolveProjectPath } from './_util.js';
import {
  analyzeWithProfile,
  profileRuleIds,
  resolveScanLanguage,
  type SecurityFinding,
  type SecurityRuleId,
} from './security-scan-languages.js';

export type { ResolvedScanLanguage, SecurityFinding } from './security-scan-languages.js';
export { resolveScanLanguage };

export interface SecurityScanInput {
  /** File path to scan (relative to project root or absolute). */
  file?: string | undefined;
  /** Direct code content to scan (optional, if scanning unwritten draft). */
  content?: string | undefined;
  /** Specific rule IDs to enable or filter by. */
  rules?: string[] | undefined;
  /**
   * Language of `content` (`typescript`, `javascript`, `swift`, `py`, …) or of
   * `file` when its extension is misleading. Defaults to the file extension;
   * inline `content` with neither is treated as TypeScript.
   */
  language?: string | undefined;
}

export interface SecurityScanOutput {
  /** `unsupported_language`: only the secret scan ran, and it found nothing. */
  status: 'clean' | 'findings_detected' | 'unsupported_language';
  /** Language the scan resolved for this input. */
  language?: string | undefined;
  /** False when no code rules exist for `language` (only the secret scan ran). */
  languageSupported?: boolean | undefined;
  /** Rule ids that were evaluated, so a clean result says what it actually covered. */
  rulesChecked?: SecurityRuleId[] | undefined;
  filesScanned: number;
  totalFindings: number;
  criticalCount: number;
  warningCount: number;
  findings: SecurityFinding[];
  summary: string;
}

// ─── Secret & Token Patterns ────────────────────────────────────────────────
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'AWS Access Key', regex: /\b(AKIA[0-9A-Z]{16})\b/ },
  { name: 'GitHub Token', regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/ },
  { name: 'Stripe Secret Key', regex: /\b(sk_live_[0-9a-zA-Z]{24,})\b/ },
  { name: 'Slack Token', regex: /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/ },
  // Any type words (ENCRYPTED, PGP, …); PGP armor ends in ` BLOCK`.
  {
    name: 'Private Key Header',
    regex: /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/,
  },
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

const JS_TS_RULE_IDS: SecurityRuleId[] = [
  'sec/hardcoded-secret',
  'sec/prototype-pollution',
  'sec/unsafe-dynamic-exec',
  'sec/sql-injection',
  'sec/redos-vulnerable-regex',
  'perf/n-plus-one-query',
];

export function analyzeSecurityAndPerformance(
  filePath: string,
  content: string,
  options: { secretsOnly?: boolean } = {},
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');
  const relPath = filePath.replace(/\\/g, '/');

  // Skip test fixtures and mock data from secret scans
  // The word must start a path segment or a `.`/`_`/`-` part: without that
  // left boundary `latest.ts`, `src/api/latest/`, `contest.ts` or
  // `hammock.tsx` counted as test files and skipped the secret scan.
  const isTestFile = /(?:^|[/\\._-])(?:test|spec|mock|fixture)[s]?[/\\._]/i.test(relPath);

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

  // Rules 2-6 are JS/TS idioms; on other languages they would be noise at best.
  if (options.secretsOnly) return findings;

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
    '(N+1 SQL queries, SQL injection, hardcoded secrets, prototype pollution, ReDoS, and unsafe eval). ' +
    'Code rules cover JavaScript/TypeScript plus Python, Go, Rust, Java, Kotlin, Scala, C#, PHP, Ruby, Swift, C/C++ and shell; any other language gets the secret scan and reports `unsupported_language`.',
  usageHint:
    'RUN AFTER WRITING OR REFACTORING CODE TO CATCH HIDDEN DEFECTS:\n\n' +
    '- Pass `file: "src/user-service.ts"` or direct `content: "..."` (add `language` for non-TS content).\n' +
    '- `status: "unsupported_language"` means the code was NOT checked (only secrets were scanned), not that it is clean.\n' +
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
      language: {
        type: 'string',
        description:
          'Language of `content` or `file` (e.g. typescript, javascript, swift, py). ' +
          'Defaults to the file extension; inline content with neither is treated as TypeScript.',
      },
    },
    additionalProperties: false,
  },
  // Failures THROW so the executor marks the call is_error. The old catch
  // returned `status: 'error'`, which the executor recorded as a successful
  // call — for a scanner that reads as "ran fine", the worst possible lie.
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const resolved = resolveScanLanguage(input.file, input.language);
    const inlineExt = resolved.profile?.extensions[0] ?? (resolved.supported ? 'ts' : resolved.id);
    let targetFile = input.file ?? `inline-code.${inlineExt}`;
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

    // JS/TS run the dedicated rules; other supported languages run their profile
    // table on top of the language-agnostic secret scan; the rest get secrets only.
    let findings = analyzeSecurityAndPerformance(targetFile, content, {
      secretsOnly: resolved.profile !== undefined || !resolved.supported,
    });
    if (resolved.profile) {
      findings = [...findings, ...analyzeWithProfile(targetFile, content, resolved.profile)];
    }
    let rulesChecked: SecurityRuleId[] = !resolved.supported
      ? ['sec/hardcoded-secret']
      : resolved.profile
        ? ['sec/hardcoded-secret', ...profileRuleIds(resolved.profile)]
        : JS_TS_RULE_IDS;

    if (input.rules && input.rules.length > 0) {
      const ruleSet = new Set(input.rules);
      findings = findings.filter((f) => ruleSet.has(f.ruleId));
      rulesChecked = rulesChecked.filter((id) => ruleSet.has(id));
    }

    const criticalCount = findings.filter((f) => f.severity === 'critical').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;
    const totalFindings = findings.length;

    const status: SecurityScanOutput['status'] =
      totalFindings > 0
        ? 'findings_detected'
        : resolved.supported
          ? 'clean'
          : 'unsupported_language';
    const unsupportedNote = resolved.supported
      ? ''
      : ` Only the secret scan ran: no code rules exist for "${resolved.id}".`;
    const summary =
      status === 'unsupported_language'
        ? `Security & Performance AST Scan: NOT CHECKED (${targetFile}). Unsupported language "${resolved.id}": only the secret scan ran and found nothing. This is not a clean result.`
        : status === 'clean'
          ? `Security & Performance AST Scan: CLEAN (${targetFile}), checked: ${rulesChecked.join(', ')}`
          : `Security & Performance AST Scan: ${totalFindings} issue(s) detected (${criticalCount} critical, ${warningCount} warning).${unsupportedNote}`;

    return {
      status,
      language: resolved.id,
      languageSupported: resolved.supported,
      rulesChecked,
      filesScanned: 1,
      totalFindings,
      criticalCount,
      warningCount,
      findings,
      summary,
    };
  },
};
