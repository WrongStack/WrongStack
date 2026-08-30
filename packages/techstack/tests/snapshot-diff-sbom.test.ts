import { describe, expect, it } from 'vitest';
import { diffSnapshots, toSpdx, toCycloneDX } from '../src/index.js';
import type { Snapshot } from '../src/types.js';

const BASE_SNAPSHOT: Snapshot = {
  id: 'snap-old',
  projectId: 'proj-1',
  targetRoot: '/tmp/project',
  fingerprint: 'ts-old',
  createdAt: '2026-07-16T10:00:00.000Z',
  adapterVersion: '0.1.0',
  coverage: 'full',
  workspaces: [],
  dependencies: [
    { id: 'dep-1', workspaceId: 'ws-1', ecosystem: 'npm', name: 'express', sourceType: 'registry', direct: true, scope: 'runtime', locked: '4.18.2', status: 'current', evidence: [] },
    { id: 'dep-2', workspaceId: 'ws-1', ecosystem: 'npm', name: 'lodash', sourceType: 'registry', direct: true, scope: 'runtime', locked: '4.17.20', status: 'current', evidence: [] },
    { id: 'dep-3', workspaceId: 'ws-1', ecosystem: 'npm', name: 'old-pkg', sourceType: 'registry', direct: true, scope: 'runtime', locked: '1.0.0', status: 'current', evidence: [] },
  ],
  findings: [],
};

const NEW_SNAPSHOT: Snapshot = {
  ...BASE_SNAPSHOT,
  id: 'snap-new',
  fingerprint: 'ts-new',
  createdAt: '2026-07-16T12:00:00.000Z',
  dependencies: [
    { id: 'dep-1', workspaceId: 'ws-1', ecosystem: 'npm', name: 'express', sourceType: 'registry', direct: true, scope: 'runtime', locked: '4.19.0', status: 'update_available_safe', evidence: [] },
    { id: 'dep-2', workspaceId: 'ws-1', ecosystem: 'npm', name: 'lodash', sourceType: 'registry', direct: true, scope: 'runtime', locked: '4.17.20', status: 'current', evidence: [] },
    { id: 'dep-4', workspaceId: 'ws-1', ecosystem: 'npm', name: 'new-pkg', sourceType: 'registry', direct: true, scope: 'runtime', locked: '2.0.0', status: 'current', evidence: [] },
  ],
};

describe('diffSnapshots', () => {
  it('identifies added dependencies', () => {
    const diff = diffSnapshots(BASE_SNAPSHOT, NEW_SNAPSHOT);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.name).toBe('new-pkg');
  });

  it('identifies removed dependencies', () => {
    const diff = diffSnapshots(BASE_SNAPSHOT, NEW_SNAPSHOT);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.name).toBe('old-pkg');
  });

  it('identifies changed dependencies', () => {
    const diff = diffSnapshots(BASE_SNAPSHOT, NEW_SNAPSHOT);
    expect(diff.changed.length).toBeGreaterThanOrEqual(2);
    const lockedChange = diff.changed.find((c) => c.field === 'locked');
    expect(lockedChange).toBeDefined();
    expect(lockedChange?.from).toBe('4.18.2');
    expect(lockedChange?.to).toBe('4.19.0');
    const statusChange = diff.changed.find((c) => c.field === 'status');
    expect(statusChange).toBeDefined();
    expect(statusChange?.from).toBe('current');
    expect(statusChange?.to).toBe('update_available_safe');
  });

  it('returns empty diff for identical snapshots', () => {
    const diff = diffSnapshots(BASE_SNAPSHOT, BASE_SNAPSHOT);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('does not report changes when optional fields are both undefined or null', () => {
    const snapA: Snapshot = {
      ...BASE_SNAPSHOT,
      dependencies: [
        { id: 'dep-1', workspaceId: 'ws-1', ecosystem: 'npm', name: 'pkg-a', sourceType: 'registry', direct: true, scope: 'runtime', status: 'current', evidence: [] },
      ],
    };
    const snapB: Snapshot = {
      ...snapA,
      dependencies: [
        { id: 'dep-1', workspaceId: 'ws-1', ecosystem: 'npm', name: 'pkg-a', sourceType: 'registry', direct: true, scope: 'runtime', status: 'current', evidence: [] },
      ],
    };
    const diff = diffSnapshots(snapA, snapB);
    expect(diff.changed).toHaveLength(0);
  });
});

describe('SBOM export', () => {
  it('generates valid SPDX document', () => {
    const spdx = toSpdx(BASE_SNAPSHOT);
    expect(spdx.spdxVersion).toBe('SPDX-2.3');
    expect(spdx.dataLicense).toBe('CC0-1.0');
    expect(spdx.packages).toHaveLength(3);
    expect(spdx.packages[0]?.name).toBe('express');
    expect(spdx.packages[0]?.versionInfo).toBe('4.18.2');
  });

  it('generates valid CycloneDX BOM', () => {
    const bom = toCycloneDX(BASE_SNAPSHOT);
    expect(bom.bomFormat).toBe('CycloneDX');
    expect(bom.specVersion).toBe('1.5');
    expect(bom.components).toHaveLength(3);
    expect(bom.components[0]?.name).toBe('express');
    expect(bom.components[0]?.version).toBe('4.18.2');
    expect(bom.components[0]?.type).toBe('library');
  });
});
