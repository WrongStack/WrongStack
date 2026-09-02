/**
 * Plan templates — pre-defined plan skeletons for common workflows.
 *
 * Templates are stored in-memory (no disk I/O). Users instantiate them
 * via `/plan template use <name>` or `planTool(action: 'template_use')`.
 * Each template is a function that returns an array of item titles, so
 * dynamic content (dates, project names) can be injected later.
 */

export interface PlanTemplate {
  name: string;
  description: string;
  category: 'development' | 'release' | 'maintenance' | 'infrastructure';
  items: Array<{
    title: string;
    details?: string | undefined;
  }>;
}

const templates: Record<string, PlanTemplate> = {
  'new-feature': {
    name: 'new-feature',
    description: 'Standard workflow for adding a new feature',
    category: 'development',
    items: [
      {
        title: 'Write specification / design doc',
        details: 'Define scope, acceptance criteria, edge cases',
      },
      { title: 'Set up feature branch', details: 'git checkout -b feature/...' },
      { title: 'Implement core logic', details: 'TDD preferred — write tests first' },
      { title: 'Add unit tests', details: '>= 80% coverage for new code' },
      { title: 'Add integration tests', details: 'End-to-end happy path + error paths' },
      { title: 'Update documentation', details: 'README, API docs, changelog' },
      { title: 'Code review', details: 'Self-review before requesting review' },
      { title: 'Merge and deploy', details: 'CI green, tag release' },
    ],
  },
  'bug-fix': {
    name: 'bug-fix',
    description: 'Systematic approach to fixing bugs',
    category: 'maintenance',
    items: [
      { title: 'Reproduce the bug', details: 'Minimal reproduction case' },
      { title: 'Root cause analysis', details: 'Trace through logs, debugger' },
      { title: 'Write failing test', details: 'Test must fail before fix' },
      { title: 'Implement fix', details: 'Smallest possible change' },
      { title: 'Verify fix', details: 'Test passes, reproduction no longer fails' },
      { title: 'Regression test', details: 'Ensure no related tests broken' },
      { title: 'Document in changelog', details: 'Brief description + issue link' },
    ],
  },
  refactor: {
    name: 'refactor',
    description: 'Safe refactoring workflow',
    category: 'maintenance',
    items: [
      {
        title: 'Identify refactoring target',
        details: 'Code smell, performance bottleneck, or tech debt',
      },
      { title: 'Ensure test coverage', details: 'Existing tests must pass before and after' },
      { title: 'Write characterization tests', details: 'Capture current behavior if tests weak' },
      { title: 'Apply refactoring', details: 'Small steps, frequent commits' },
      { title: 'Run full test suite', details: 'All tests must pass' },
      { title: 'Performance check', details: 'Ensure no regression' },
      { title: 'Code review', details: 'Explain the why, not just the what' },
    ],
  },
  release: {
    name: 'release',
    description: 'Preparing a new release',
    category: 'release',
    items: [
      { title: 'Version bump', details: 'package.json, lockfiles, tags' },
      { title: 'Update changelog', details: 'All changes since last release' },
      { title: 'Run full test suite', details: 'Unit + integration + e2e' },
      { title: 'Build artifacts', details: 'Docker images, bundles, binaries' },
      { title: 'Staging smoke tests', details: 'Deploy to staging, verify' },
      { title: 'Production deploy', details: 'Blue-green or canary' },
      { title: 'Post-deploy verification', details: 'Health checks, error rates' },
      { title: 'Announce release', details: 'Slack, email, GitHub release notes' },
    ],
  },
  'security-audit': {
    name: 'security-audit',
    description: 'Security review and hardening',
    category: 'infrastructure',
    items: [
      { title: 'Dependency audit', details: 'npm audit, Snyk, Dependabot alerts' },
      { title: 'Secret scan', details: 'git-secrets, truffleHog, manual review' },
      { title: 'Access control review', details: 'IAM, roles, least privilege' },
      { title: 'Input validation audit', details: 'SQL injection, XSS, path traversal' },
      { title: 'Authentication review', details: 'Session management, MFA, password policy' },
      { title: 'Logging and monitoring', details: 'PII in logs, audit trails' },
      { title: 'Incident response plan', details: 'Runbooks, contacts, escalation' },
    ],
  },
  onboarding: {
    name: 'onboarding',
    description: 'New developer onboarding checklist',
    category: 'infrastructure',
    items: [
      { title: 'Repository access', details: 'GitHub/GitLab permissions' },
      { title: 'Local environment setup', details: 'Docker, dependencies, env files' },
      { title: 'Run tests locally', details: 'Verify green suite' },
      { title: 'Read architecture docs', details: 'ADR, README, onboarding guide' },
      { title: 'First commit', details: 'Docs fix or small improvement' },
      { title: 'Pair programming session', details: 'Walk through codebase with buddy' },
      { title: 'Deploy to staging', details: 'Verify CI/CD access' },
    ],
  },
};

export function listPlanTemplates(): PlanTemplate[] {
  return Object.values(templates);
}

export function getPlanTemplate(name: string): PlanTemplate | undefined {
  return templates[name];
}

export function formatPlanTemplates(): string {
  const cats = new Map<PlanTemplate['category'], PlanTemplate[]>();
  for (const t of Object.values(templates)) {
    const arr = cats.get(t.category) ?? [];
    arr.push(t);
    cats.set(t.category, arr);
  }

  const lines: string[] = ['Available plan templates:'];
  for (const [cat, items] of cats) {
    lines.push(`\n${cat}:`);
    for (const t of items) {
      lines.push(`  ${t.name.padEnd(18)} — ${t.description}`);
    }
  }
  return lines.join('\n');
}
