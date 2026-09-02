import { toCycloneDX, toSpdx } from '../sbom.js';
import type { Snapshot } from '../types.js';

export type ReportFormat = 'md' | 'json' | 'spdx' | 'cyclonedx';

export function generateReport(snapshot: Snapshot, format: ReportFormat = 'md'): string {
  if (format === 'json') return JSON.stringify(snapshot, null, 2);
  if (format === 'spdx') return JSON.stringify(toSpdx(snapshot), null, 2);
  if (format === 'cyclonedx') return JSON.stringify(toCycloneDX(snapshot), null, 2);
  const lines = [
    '# TechStack Report',
    '',
    `**Generated:** ${snapshot.createdAt}`,
    `**Target:** ${snapshot.targetRoot}`,
    `**Fingerprint:** ${snapshot.fingerprint}`,
    `**Workspaces:** ${snapshot.workspaces.length}`,
    `**Dependencies:** ${snapshot.dependencies.length}`,
    `**Findings:** ${snapshot.findings.length}`,
    `**Coverage:** ${snapshot.coverage}`,
    '',
  ];
  if (snapshot.workspaces.length > 0) {
    lines.push(
      '## Workspaces',
      '',
      '| Workspace | Ecosystem | Coverage | Deps |',
      '|---|---|---|---|',
    );
    for (const workspace of snapshot.workspaces) {
      const count = snapshot.dependencies.filter(
        (dependency) => dependency.workspaceId === workspace.id,
      ).length;
      lines.push(
        `| ${workspace.relativeRoot} | ${workspace.ecosystem} | ${workspace.coverage} | ${count} |`,
      );
    }
    lines.push('');
  }
  if (snapshot.findings.length > 0) {
    lines.push('## Findings', '');
    const bySeverity = new Map<string, typeof snapshot.findings>();
    for (const finding of snapshot.findings)
      bySeverity.set(finding.severity, [...(bySeverity.get(finding.severity) ?? []), finding]);
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      const findings = bySeverity.get(severity);
      if (!findings?.length) continue;
      lines.push(
        `### ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${findings.length})`,
        '',
      );
      for (const finding of findings) {
        const dependency = snapshot.dependencies.find(
          (candidate) => candidate.id === finding.dependencyId,
        );
        lines.push(
          `- **${dependency?.name ?? finding.dependencyId}** — ${finding.type} — ${finding.rationale}`,
        );
      }
      lines.push('');
    }
  }
  if (snapshot.dependencies.length > 0) {
    lines.push(
      '## Dependencies',
      '',
      '| Name | Ecosystem | Status | Locked | Latest |',
      '|---|---|---|---|---|',
    );
    for (const dependency of snapshot.dependencies) {
      lines.push(
        `| ${dependency.name} | ${dependency.ecosystem} | ${dependency.status} | ${dependency.locked ?? '—'} | ${dependency.latestStable ?? '—'} |`,
      );
    }
  }
  return lines.join('\n');
}
