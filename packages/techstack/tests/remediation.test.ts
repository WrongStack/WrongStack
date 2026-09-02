import { describe, expect, it } from 'vitest';
import { generateUpgradePlan, renderPlanMarkdown } from '../src/remediation.js';
import type { Snapshot, Finding, DependencyObservation } from '../src/types.js';

const DEPS: readonly DependencyObservation[] = [
  {
    id: 'dep-1',
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'express',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '4.18.2',
    latestStable: '4.19.0',
    status: 'update_available_safe',
    evidence: [],
  },
  {
    id: 'dep-2',
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'lodash',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '4.17.20',
    latestStable: '4.17.21',
    status: 'current',
    evidence: [],
  },
  {
    id: 'dep-3',
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'old-lib',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '1.0.0',
    latestStable: '3.0.0',
    status: 'update_available_breaking',
    evidence: [],
  },
  {
    id: 'dep-4',
    workspaceId: 'ws-1',
    ecosystem: 'python',
    name: 'requests',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '2.28.0',
    latestStable: '2.31.0',
    status: 'vulnerable',
    evidence: [],
  },
];

const FINDINGS: readonly Finding[] = [
  {
    id: 'f-1',
    dependencyId: 'dep-1',
    type: 'upgrade',
    severity: 'info',
    action: 'upgrade_minor',
    confidence: 1,
    rationale: 'A newer compatible version is available',
    evidence: [],
  },
  {
    id: 'f-2',
    dependencyId: 'dep-3',
    type: 'upgrade',
    severity: 'low',
    action: 'upgrade_major',
    confidence: 1,
    rationale: 'Major version available, may require breaking changes',
    breakingRisk: 'API changes in 3.x',
    evidence: [],
  },
  {
    id: 'f-3',
    dependencyId: 'dep-4',
    type: 'vulnerability',
    severity: 'high',
    action: 'upgrade_patch',
    confidence: 1,
    rationale: 'Security advisory: CVE-2023-1234',
    evidence: [],
  },
];

const SNAPSHOT: Snapshot = {
  id: 'snap-test',
  projectId: 'proj-1',
  targetRoot: '/tmp',
  fingerprint: 'ts-test',
  createdAt: '2026-07-16T12:00:00.000Z',
  adapterVersion: '0.1.0',
  coverage: 'full',
  workspaces: [],
  dependencies: DEPS,
  findings: FINDINGS,
};

describe('generateUpgradePlan', () => {
  it('includes only actionable findings (action !== none)', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((i) => i.action !== 'none')).toBe(true);
  });

  it('sorts by severity (critical/high first)', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    expect(plan.items[0]?.severity).toBe('high');
    expect(plan.items[1]?.severity).toBe('low');
    expect(plan.items[2]?.severity).toBe('info');
  });

  it('populates version info correctly', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    const expressItem = plan.items.find((i) => i.dependencyName === 'express');
    expect(expressItem?.currentVersion).toBe('4.18.2');
    expect(expressItem?.targetVersion).toBe('4.19.0');
  });

  it('suggests correct commands per ecosystem', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    const npmItem = plan.items.find((i) => i.ecosystem === 'npm' && i.dependencyName === 'express');
    expect(npmItem?.suggestedCommand).toContain('npm install express');
    const pyItem = plan.items.find((i) => i.ecosystem === 'python');
    expect(pyItem?.suggestedCommand).toContain('pip install requests');
  });

  it('summary counts match items', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    expect(plan.summary.total).toBe(3);
    expect(plan.summary.patch).toBe(1);
    expect(plan.summary.minor).toBe(1);
    expect(plan.summary.major).toBe(1);
    expect(plan.summary.replace).toBe(0);
    expect(plan.summary.remove).toBe(0);
  });

  it('includes the read-only warning', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    expect(plan.warning).toContain('read-only');
    expect(plan.warning).toContain('explicitly approve');
  });

  it('returns empty plan for clean snapshot', () => {
    const cleanSnapshot: Snapshot = { ...SNAPSHOT, findings: [] };
    const plan = generateUpgradePlan(cleanSnapshot);
    expect(plan.items).toHaveLength(0);
    expect(plan.summary.total).toBe(0);
  });
});

describe('renderPlanMarkdown', () => {
  it('renders a structured Markdown document', () => {
    const plan = generateUpgradePlan(SNAPSHOT);
    const md = renderPlanMarkdown(plan);
    expect(md).toContain('# TechStack Remediation Plan');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Items');
    expect(md).toContain('express');
    expect(md).toContain('old-lib');
    expect(md).toContain('requests');
    expect(md).toContain('npm install express');
    expect(md).toContain('⚠️');
  });

  it('renders "no actions" for clean snapshot', () => {
    const cleanSnapshot: Snapshot = { ...SNAPSHOT, findings: [] };
    const plan = generateUpgradePlan(cleanSnapshot);
    const md = renderPlanMarkdown(plan);
    expect(md).toContain('No remediation actions needed');
  });
});
