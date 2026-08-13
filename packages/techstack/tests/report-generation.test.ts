import { describe, expect, it } from 'vitest';
import { TechStackEngine, TechStackStore } from '../src/index.js';
import type { Snapshot } from '../src/types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

function createTestStore(): TechStackStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techstack-report-'));
  const store = new TechStackStore({ projectSlug: 'test', dbPath: path.join(tmpDir, 'test.db') });
  return store;
}

const SAMPLE_SNAPSHOT: Snapshot = {
  id: 'snap-1',
  projectId: 'proj-1',
  targetRoot: '/tmp/project',
  fingerprint: 'ts-abc123',
  createdAt: '2026-07-16T12:00:00.000Z',
  adapterVersion: '0.1.0',
  coverage: 'full',
  workspaces: [
    {
      id: 'ws-1',
      relativeRoot: '.',
      ecosystem: 'npm',
      manifests: ['package.json'],
      lockfiles: ['pnpm-lock.yaml'],
      confidence: 1,
      coverage: 'full',
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      workspaceId: 'ws-1',
      ecosystem: 'npm',
      name: 'express',
      sourceType: 'registry',
      direct: true,
      scope: 'runtime',
      requested: '^4.18.0',
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
      requested: '^4.17.0',
      locked: '4.17.21',
      latestStable: '4.17.21',
      status: 'current',
      evidence: [],
    },
  ],
  findings: [
    {
      id: 'finding-dep-1-update',
      dependencyId: 'dep-1',
      type: 'upgrade',
      severity: 'info',
      action: 'upgrade_minor',
      confidence: 1.0,
      rationale: 'A newer compatible version is available',
      evidence: [],
    },
  ],
};

describe('TechStackEngine.generateReport', () => {
  it('generates a markdown report with workspace, findings, and dependency tables', () => {
    const store = createTestStore();
    const engine = new TechStackEngine(store);
    const report = engine.generateReport(SAMPLE_SNAPSHOT, 'md');
    store.close();

    expect(report).toContain('# TechStack Report');
    expect(report).toContain('**Target:** /tmp/project');
    expect(report).toContain('## Workspaces');
    expect(report).toContain('| . | npm | full | 2 |');
    expect(report).toContain('## Findings');
    expect(report).toContain('### Info (1)');
    expect(report).toContain('**express** — upgrade');
    expect(report).toContain('## Dependencies');
    expect(report).toContain('| express | npm | update_available_safe | 4.18.2 | 4.19.0 |');
    expect(report).toContain('| lodash | npm | current | 4.17.21 | 4.17.21 |');
  });

  it('generates valid JSON output', () => {
    const store = createTestStore();
    const engine = new TechStackEngine(store);
    const report = engine.generateReport(SAMPLE_SNAPSHOT, 'json');
    store.close();

    const parsed = JSON.parse(report) as Snapshot;
    expect(parsed.id).toBe('snap-1');
    expect(parsed.dependencies).toHaveLength(2);
    expect(parsed.findings).toHaveLength(1);
  });

  it('handles empty snapshot gracefully', () => {
    const store = createTestStore();
    const engine = new TechStackEngine(store);
    const emptySnapshot: Snapshot = {
      ...SAMPLE_SNAPSHOT,
      workspaces: [],
      dependencies: [],
      findings: [],
    };
    const report = engine.generateReport(emptySnapshot, 'md');
    store.close();

    expect(report).toContain('# TechStack Report');
    expect(report).toContain('**Workspaces:** 0');
    expect(report).not.toContain('## Workspaces');
    expect(report).not.toContain('## Findings');
    expect(report).not.toContain('## Dependencies');
  });

  it('generates valid SPDX 2.3 SBOM output', () => {
    const store = createTestStore();
    const engine = new TechStackEngine(store);
    const report = engine.generateReport(SAMPLE_SNAPSHOT, 'spdx');
    store.close();

    const parsed = JSON.parse(report);
    expect(parsed.spdxVersion).toBe('SPDX-2.3');
    expect(parsed.name).toBe('TechStack-SBOM-proj-1');
    expect(parsed.packages).toHaveLength(2);
    expect(parsed.packages[0].name).toBe('express');
    // SPDX 2.3 required package fields (Chimera caba193f)
    for (const pkg of parsed.packages) {
      expect(pkg).toHaveProperty('SPDXID');
      expect(pkg).toHaveProperty('downloadLocation');
      expect(pkg).toHaveProperty('filesAnalyzed');
      expect(pkg).toHaveProperty('licenseConcluded');
      expect(pkg).toHaveProperty('licenseDeclared');
      expect(pkg).toHaveProperty('supplier');
      expect(pkg).toHaveProperty('copyrightText');
    }
  });

  it('generates valid CycloneDX 1.5 SBOM output', () => {
    const store = createTestStore();
    const engine = new TechStackEngine(store);
    const report = engine.generateReport(SAMPLE_SNAPSHOT, 'cyclonedx');
    store.close();

    const parsed = JSON.parse(report);
    expect(parsed.bomFormat).toBe('CycloneDX');
    expect(parsed.specVersion).toBe('1.5');
    expect(parsed.components).toHaveLength(2);
    expect(parsed.components[0].name).toBe('express');
  });
});
