import { parseUnifiedDiff } from '../evidence-analyzer/diff.js';
import { analyzeEvidence, type EvidenceRule } from '../evidence-analyzer/index.js';
import {
  type EvidenceFinding,
  gitRead,
  isTestPath,
  type ProjectCollectContext,
  type ProjectCollection,
} from '../evidence-analyzer/project.js';
import { safePrefix } from '../runtime/string-boundaries.js';
import { CHANGE_RISK_RULES } from './rules.js';

interface PathRisk {
  label: string;
  severity: EvidenceFinding['severity'];
  test: (path: string) => boolean;
  advice: string;
}

/** Risk a file carries by what it is, before reading a line of it. */
const PATH_RISKS: readonly PathRisk[] = [
  {
    label: 'persistence or migration change',
    severity: 'warning',
    test: (p) =>
      /(?:^|\/)(?:migrations?|migrate|db\/schema)\//i.test(p) ||
      /\.sql$|(?:^|\/)schema\.prisma$|(?:^|\/)drizzle\.config\./i.test(p),
    advice: 'Prove upgrade, rollback, and existing-data behavior before release.',
  },
  {
    label: 'authentication or authorization change',
    severity: 'warning',
    test: (p) =>
      /(?:^|\/|[-_.])(?:auth|authn|authz|oauth|rbac|acl|permissions?|login|sso)(?:$|\/|[-_.])/i.test(
        p,
      ),
    advice: 'Add positive and negative access-control regression coverage.',
  },
  {
    label: 'CI or release pipeline change',
    severity: 'warning',
    test: (p) =>
      /^\.github\/workflows\/|^\.gitlab-ci|(?:^|\/)Jenkinsfile$|^\.circleci\/|(?:^|\/)azure-pipelines/i.test(
        p,
      ),
    advice: 'Run the changed pipeline on a branch before relying on it for release.',
  },
  {
    label: 'infrastructure change',
    severity: 'warning',
    test: (p) =>
      /(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|\.tf$|(?:^|\/)(?:k8s|helm|charts|terraform)\//i.test(
        p,
      ),
    advice: 'Plan/diff the infrastructure change and confirm a rollback path.',
  },
  {
    label: 'dependency change',
    severity: 'info',
    test: (p) =>
      /(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock)$/.test(
        p,
      ),
    advice: 'Review added/upgraded packages and run the dependency audit.',
  },
];

/** Classify each changed file of the working tree by path and changed lines. */
export async function collectChangeRisk(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const diff = await gitRead(
    root,
    ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', '--no-renames'],
    signal,
  );
  if (diff === null) {
    throw new Error(
      'change_risk_analyze could not read `git diff HEAD` (not a git repository, no commits, or git unavailable); pass a diff as content instead',
    );
  }
  const untracked = (
    (await gitRead(root, ['ls-files', '--others', '--exclude-standard'], signal)) ?? ''
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const files = parseUnifiedDiff(diff);
  const findings: EvidenceFinding[] = [];
  const paths = [...new Set([...files.map((f) => f.path), ...untracked])];
  for (const path of paths) {
    if (isTestPath(path)) continue;
    for (const risk of PATH_RISKS) {
      if (risk.test(path)) {
        findings.push({
          rule: risk.label,
          severity: risk.severity,
          file: path,
          line: 0,
          excerpt: untracked.includes(path) ? `new file ${path}` : `changed file ${path}`,
          advice: risk.advice,
        });
      }
    }
  }
  for (const file of files) {
    if (isTestPath(file.path)) continue;
    findings.push(...lineFindings(file.path, file.added, '+', CHANGE_RISK_RULES));
    findings.push(
      ...lineFindings(
        file.path,
        file.removed.map((text) => ({ line: 0, text })),
        '-',
        CHANGE_RISK_RULES.filter((rule) => rule.label !== 'destructive operation'),
      ),
    );
  }
  const tests = paths.filter(isTestPath);
  return {
    findings: dedupe(findings),
    inspected: ['git diff HEAD', 'git ls-files --others'],
    facts: {
      changedFiles: paths.length,
      changedTestFiles: tests.length,
      untrackedFiles: untracked.length,
    },
    limitation:
      'Read-only git diff/ls-files only; untracked files are classified by path. Risk signals are prompts for targeted proof, not verdicts.',
  };
}

function lineFindings(
  path: string,
  lines: ReadonlyArray<{ line: number; text: string }>,
  sign: '+' | '-',
  rules: readonly EvidenceRule[],
): EvidenceFinding[] {
  if (lines.length === 0) return [];
  const content = lines.map((l) => l.text).join('\n');
  const profile = { name: 'change-risk', toolName: '', description: '', evidenceHint: '', rules };
  return analyzeEvidence(content, profile, 50, Date.now, 3).findings.map((finding) => ({
    ...finding,
    file: path,
    line: lines[finding.line - 1]?.line ?? 0,
    excerpt: safePrefix(`${sign} ${finding.excerpt}`, 240),
  }));
}

/** One finding per (rule, file): a path match and a line match say the same thing. */
function dedupe(findings: EvidenceFinding[]): EvidenceFinding[] {
  const seen = new Set<string>();
  const order = { error: 0, warning: 1, info: 2 } as const;
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .filter((finding) => {
      const key = `${finding.rule}\u0000${finding.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
