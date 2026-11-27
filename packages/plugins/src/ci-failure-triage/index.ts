import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
export default createEvidenceAnalyzerPlugin({
  name: 'ci-failure-triage',
  toolName: 'ci_failure_triage',
  description:
    'Classifies supplied CI logs into test, type-check, lint, build, missing-module, lockfile, out-of-memory, timeout, permission and network failure evidence',
  evidenceHint: 'Inspect CI or command output and classify actionable failure signatures.',
  rules: [
    {
      label: 'test failure',
      severity: 'error',
      pattern:
        /(?:^\s*(?:FAIL|FAILED)\b|\bAssertionError\b|Expected:|\bTests?\s+[1-9]\d*\s+failed\b)/im,
      advice:
        'Reproduce the named test locally and keep the failing assertion as the repair proof.',
    },
    {
      label: 'type-check failure',
      severity: 'error',
      pattern: /\bTS\d{4}\b|Type error:/,
      advice: 'Fix the reported type boundary rather than suppressing the diagnostic.',
    },
    {
      label: 'transient network or registry failure',
      severity: 'warning',
      pattern: /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|registry.*(?:503|504))/i,
      advice:
        'Retry once with preserved logs, then separate infrastructure failure from a product regression.',
    },
    {
      label: 'missing module or import',
      severity: 'error',
      pattern:
        /Cannot find module|ERR_MODULE_NOT_FOUND|Module not found|Could not resolve ["']|ModuleNotFoundError|Cannot find package/,
      advice:
        'Check the import path, the package build order and whether the dependency is declared in this package.',
    },
    {
      label: 'lockfile out of date in CI',
      severity: 'error',
      pattern:
        /lockfile had changes, but lockfile is frozen|ERR_PNPM_OUTDATED_LOCKFILE|npm ci can only install|lockfile needs to be updated|--frozen-lockfile.*(?:fail|error)/i,
      advice: 'Run the install locally with the declared package manager and commit the lockfile.',
    },
    {
      label: 'build or syntax failure',
      severity: 'error',
      pattern:
        /\bSyntaxError:|error during build|\bBuild failed\b|Rollup failed to resolve|\[ERROR\] .*esbuild|error: script ".*" exited/,
      advice: 'Open the first build error; later ones are usually cascades of it.',
    },
    {
      label: 'lint failure',
      severity: 'error',
      pattern:
        /\b[1-9]\d* problems? \([1-9]\d* errors?|\blint\/[a-z]+\/[A-Za-z]+\b|Checked \d+ files? in .*Found [1-9]\d* errors?/,
      advice: 'Run the project linter on the reported files and fix (or apply the safe autofix).',
    },
    {
      label: 'out of memory',
      severity: 'error',
      pattern:
        /JavaScript heap out of memory|Allocation failed - |memory allocation failed|OOMKilled|exit code 137\b|\bKilled\b\s*$/m,
      advice:
        'Distinguish a leak from a too-small runner: reproduce with the same worker count, then cap workers or raise memory.',
    },
    {
      label: 'timeout or cancellation',
      severity: 'warning',
      pattern:
        /Test timed out|timed out after \d|timeout of \d+ ?ms exceeded|exceeded the maximum execution time|The operation was canceled/i,
      advice:
        'Check whether a test hangs (open handle, unresolved promise) before raising the timeout.',
    },
    {
      label: 'filesystem permission failure',
      severity: 'warning',
      pattern: /\bEACCES\b|\bEPERM\b|Permission denied/,
      advice: 'Check file ownership/locks on the runner (Windows: a process holding the file).',
    },
  ],
});
