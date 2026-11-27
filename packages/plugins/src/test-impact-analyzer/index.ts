import { looksLikeDiff, parseUnifiedDiff } from '../evidence-analyzer/diff.js';
import { createEvidenceAnalyzerPlugin, type EvidenceFinding } from '../evidence-analyzer/index.js';
import { isTestPath } from '../evidence-analyzer/project.js';
import { collectTestImpact, isCodePath, testStem } from './project.js';

/** On a pasted diff: changed source files that no changed test in the same diff names. */
function untestedSourceInDiff(content: string): EvidenceFinding[] {
  if (!looksLikeDiff(content)) return [];
  const files = parseUnifiedDiff(content).filter((file) => file.path && isCodePath(file.path));
  const testStems = new Set(files.filter((f) => isTestPath(f.path)).map((f) => testStem(f.path)));
  // One pass for header positions; a findIndex per file was quadratic.
  const headerLine = new Map<string, number>();
  content.split('\n').forEach((line, index) => {
    if (line.startsWith('+++ b/')) headerLine.set(line.slice(6).trimEnd(), index + 1);
  });
  return files
    .filter((file) => !isTestPath(file.path) && !testStems.has(testStem(file.path)))
    .map((file) => ({
      rule: 'source change without a changed test',
      severity: 'warning' as const,
      file: file.path,
      line: headerLine.get(file.path) ?? 1,
      excerpt: file.path,
      advice: 'Map the changed unit to a focused regression test, or run the existing one.',
    }));
}

export default createEvidenceAnalyzerPlugin({
  name: 'test-impact-analyzer',
  toolName: 'test_impact_analyze',
  description:
    'Maps changed source files to the tests that cover them, and flags focused/skipped tests and coverage-threshold failures in diffs or test output',
  evidenceHint:
    'Find which tests a change needs: changed source without changed tests (with existing test files to run), committed .only/.skip, and coverage threshold failures.',
  inspect: untestedSourceInDiff,
  rules: [
    {
      label: 'focused test committed',
      severity: 'error',
      pattern: /^\+.*\b(?:(?:it|test|describe|context)\.only\(|f(?:it|describe)\()/m,
      advice: 'Remove .only before merging: it silently skips every other test in the file.',
    },
    {
      label: 'skipped test added',
      severity: 'warning',
      pattern:
        /^\+.*\b(?:(?:it|test|describe)\.(?:skip|todo)\(|x(?:it|describe|test)\(|@pytest\.mark\.skip|t\.Skip\()/m,
      advice: 'Record why the scenario is skipped and restore coverage when practical.',
    },
    {
      label: 'coverage threshold failure',
      severity: 'error',
      pattern: /coverage threshold.*(?:not met|failed)|thresholds? .*not met/i,
      advice: 'Add or adjust tests before accepting the change.',
    },
  ],
  project: {
    description:
      'reads the changed files (`git diff HEAD` + untracked), maps each changed source file to existing test files by name, and reports .only/.skip added in changed tests; facts.suggestedTests lists the test files to run.',
    collect: collectTestImpact,
  },
});
