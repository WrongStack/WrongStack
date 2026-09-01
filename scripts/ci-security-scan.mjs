#!/usr/bin/env node
// CI repo security scan (VF-20, security report Phase 4). Before this script
// existed, only unit tests OF the scanners ran in CI — nothing scanned the
// repository itself. It runs the repo's own analyzer
// (@wrongstack/tools analyzeSecurityAndPerformance) over the repo's own
// first-party source: hardcoded secrets, unsafe dynamic execution
// (eval / new Function), SQL interpolation, prototype pollution, and
// ReDoS-shaped regexes. Wired into `.github/workflows/ci.yml` as the
// `security-scan` job, after `build` (the analyzer is imported from dist).
//
// Exit codes: 0 clean (warnings allowed); 1 any critical finding; 2 setup
// failure (e.g. no source found).
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { analyzeSecurityAndPerformance } from '@wrongstack/tools';

// The analyzer exposes several rules; only the two HIGH-PRECISION ones gate
// CI: `sec/hardcoded-secret` and `sec/unsafe-dynamic-eval` (zero false
// positives on the current tree — first full run: 0 hits of each).
// `sec/redos-vulnerable-regex` and `sec/prototype-pollution` are SHAPE rules:
// their 47 first-run hits include the repo's own regex-guard library and
// hasOwn-guarded deep-merge — they are reported as advisory triage candidates
// until reviewed, then promoted back into GATED_RULE_PATTERN.
// `sec/sql-injection` (raw-SQL-concat shape) is advisory for the same reason:
// ~800 template-literal false positives on non-SQL UI code; the repo's SQL
// surface was verified to use bound parameters throughout (security report,
// "What was verified as correct").
const GATED_RULE_PATTERN = /^sec\/(hardcoded-secret|unsafe-dynamic-eval)$/;
const RULE_FIELD_NAMES = ['ruleId', 'rule', 'id'];

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// First-party security tooling legitimately CONTAINS credential-shaped
// literals — they are the detection patterns themselves, so scanning them is
// noise by construction. Add entries here only with a stated reason; this
// list is the scan's own drift control.
const EXCLUDES = [
  // The scrubber's PATTERN table (token regexes) would self-match.
  'packages/core/src/security/secret-scrubber.ts',
  // Detection patterns — the WS-034 port source of the scrubber table.
  'packages/plugin-sdk/src/runtime/credential-patterns.ts',
  // The scanner package itself: pattern tables for every provider token.
  'packages/security-scanner/src/',
  // Secret-scanner plugin's own pattern definitions.
  'packages/plugins/src/secret-scanner/',
];

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'tests', 'e2e']);

/** @returns {Generator<string>} absolute paths of .ts/.tsx/.mts source files */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) yield full;
  }
}

const files = [];
for (const root of ['packages', 'apps']) {
  const rootAbs = path.join(REPO_ROOT, root);
  for (const abs of walk(rootAbs)) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    // Only compiled source trees: tests/ and fixture dirs are excluded by
    // construction (tests are not shipped), src/ is the shipped surface.
    if (!rel.includes('/src/')) continue;
    if (EXCLUDES.some((x) => rel === x || rel.startsWith(x))) continue;
    files.push({ abs, rel });
  }
}

if (files.length === 0) {
  console.error('ci-security-scan: no source files found — check the walk roots.');
  process.exit(2);
}

let critical = 0;
let warnings = 0;
let advisory = 0;
for (const { abs, rel } of files) {
  const content = readFileSync(abs, 'utf8');
  for (const finding of analyzeSecurityAndPerformance(rel, content)) {
    const rule =
      RULE_FIELD_NAMES.map((f) => finding[f]).find((v) => typeof v === 'string') ?? 'unknown';
    const gated = GATED_RULE_PATTERN.test(rule);
    const severity = gated ? 'critical' : (finding.severity ?? 'warning');
    if (gated) {
      critical += 1;
      const at = finding.line ? `${rel}:${finding.line}` : rel;
      console.error(`✖ ${at} [${rule}] ${finding.message ?? ''}`);
    } else if (severity === 'critical') {
      // Non-gated rules with critical findings (e.g. the SQL shape rule)
      // are advisory: counted, not blocking.
      advisory += 1;
    } else {
      warnings += 1;
    }
  }
}

console.log(
  `scanned ${files.length} source files — ${critical} critical, ${advisory} advisory-critical (non-gating rules), ${warnings} warning(s)`,
);
if (advisory + warnings > 0) {
  console.log(
    '(advisory findings are from non-gating shape rules; extend EXCLUDES only for pattern-table noise, with a reason)',
  );
}
process.exit(critical > 0 ? 1 : 0);
