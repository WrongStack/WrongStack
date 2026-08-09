import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PickerItem } from '../src/project-picker.js';
import {
  buildPickerItems,
  effectiveVisibleHeight,
  filterItems,
  skipDivider,
} from '../src/project-picker.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function projectItem(
  over: Partial<PickerItem> & { key: string; label: string } = { key: 'a', label: 'Project A' },
): PickerItem {
  return {
    key: over.key,
    label: over.label,
    subtitle: over.subtitle,
    meta: over.meta,
    kind: over.kind ?? 'project',
  };
}

function actionItem(key: string, label: string, meta?: string): PickerItem {
  return { key, label, kind: 'action', meta };
}

function dividerItem(): PickerItem {
  return { key: '__divider__', label: '───', kind: 'action' };
}

// ── Temp manifest setup ────────────────────────────────────────────────────

let tempDir: string;
let projectsJsonPath: string;

beforeAll(async () => {
  tempDir = path.join(tmpdir(), `wstack-picker-test-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  projectsJsonPath = path.join(tempDir, 'projects.json');
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeManifest(
  projects: Array<{ name: string; root: string; slug: string; lastSeen?: string }>,
) {
  await fs.writeFile(projectsJsonPath, JSON.stringify({ projects }), 'utf8');
}

// ── filterItems ─────────────────────────────────────────────────────────────

describe('filterItems', () => {
  it('returns all items when filter is empty', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'Alpha' }),
      projectItem({ key: 'b', label: 'Beta' }),
      actionItem('quit', 'Quit'),
    ];
    const result = filterItems(items, '');
    expect(result).toEqual(items);
  });

  it('filters project items by label (case-insensitive)', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'My Project', subtitle: '/home/projects/my-project' }),
      projectItem({ key: 'b', label: 'Another Repo', subtitle: '/home/work/other-repo' }),
    ];
    const result = filterItems(items, 'project');
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('a');
    // Case-insensitive
    expect(filterItems(items, 'PROJECT')).toHaveLength(1);
  });

  it('filters project items by subtitle', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'Alpha', subtitle: '/home/work/backend' }),
      projectItem({ key: 'b', label: 'Beta', subtitle: '/home/work/frontend' }),
    ];
    expect(filterItems(items, 'backend')).toHaveLength(1);
    expect(filterItems(items, 'backend')[0]?.key).toBe('a');
    expect(filterItems(items, 'front')).toHaveLength(1);
    expect(filterItems(items, 'front')[0]?.key).toBe('b');
  });

  it('always includes action items and dividers', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'Alpha' }),
      dividerItem(),
      actionItem('new', 'New Session'),
      actionItem('quit', 'Quit'),
    ];
    const result = filterItems(items, 'zzz_no_match');
    // Action items + dividers should still be present
    expect(result.filter((i) => i.kind === 'action')).toHaveLength(3);
    expect(result.filter((i) => i.kind === 'project')).toHaveLength(0);
  });

  it('returns empty when no project items match any filter', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'Alpha' }),
      projectItem({ key: 'b', label: 'Beta' }),
    ];
    const result = filterItems(items, 'zeta');
    expect(result.filter((i) => i.kind === 'project')).toHaveLength(0);
  });

  it('partial match works mid-string', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'super-project-one' }),
      projectItem({ key: 'b', label: 'other-thing' }),
    ];
    expect(filterItems(items, 'proj')).toHaveLength(1);
    expect(filterItems(items, 'proj')[0]?.key).toBe('a');
  });
});

// ── skipDivider ─────────────────────────────────────────────────────────────

describe('skipDivider', () => {
  it('skips forward over dividers', () => {
    const items: PickerItem[] = [
      dividerItem(),
      dividerItem(),
      projectItem({ key: 'a', label: 'A' }),
      projectItem({ key: 'b', label: 'B' }),
    ];
    expect(skipDivider(items, 0, 1)).toBe(2);
    expect(skipDivider(items, 1, 1)).toBe(2);
  });

  it('skips backward over dividers', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'A' }),
      dividerItem(),
      dividerItem(),
      projectItem({ key: 'b', label: 'B' }),
    ];
    // Start at index 2 (a divider), skip backward to 0 (project A)
    expect(skipDivider(items, 2, -1)).toBe(0);
    // Start at index 1 (a divider), skip backward to 0 (project A)
    expect(skipDivider(items, 1, -1)).toBe(0);
  });

  it('clamps to bounds when all items are dividers', () => {
    const items: PickerItem[] = [dividerItem(), dividerItem()];
    expect(skipDivider(items, 0, 1)).toBe(1); // no non-divider → stays at end
    expect(skipDivider(items, 1, -1)).toBe(0); // no non-divider → stays at start
  });

  it('returns same index when not on divider', () => {
    const items: PickerItem[] = [
      projectItem({ key: 'a', label: 'A' }),
      projectItem({ key: 'b', label: 'B' }),
    ];
    expect(skipDivider(items, 0, 1)).toBe(0);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });

  it('stays at last item when skipping forward at end', () => {
    const items: PickerItem[] = [projectItem({ key: 'a', label: 'A' }), dividerItem()];
    expect(skipDivider(items, 1, 1)).toBe(1); // clamped
  });

  it('stays at first item when skipping backward at start', () => {
    const items: PickerItem[] = [dividerItem(), projectItem({ key: 'a', label: 'A' })];
    expect(skipDivider(items, 0, -1)).toBe(0);
  });
});

// ── effectiveVisibleHeight ──────────────────────────────────────────────────

describe('effectiveVisibleHeight', () => {
  it('returns base height minus filter overhead when filter is active', () => {
    expect(effectiveVisibleHeight(20, 'abc')).toBe(18); // 20 - 2
  });

  it('returns base height unchanged when filter is empty', () => {
    expect(effectiveVisibleHeight(20, '')).toBe(20);
  });

  it('floors at minimum 3', () => {
    expect(effectiveVisibleHeight(2, 'abc')).toBe(3);
    expect(effectiveVisibleHeight(1, '')).toBe(3);
    expect(effectiveVisibleHeight(0, 'abc')).toBe(3);
  });

  it('handles large values', () => {
    expect(effectiveVisibleHeight(100, 'x')).toBe(98);
  });
});

// ── buildPickerItems ────────────────────────────────────────────────────────

describe('buildPickerItems', () => {
  it('returns action items only when manifest is empty', async () => {
    await writeManifest([]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    // Should have divider + 3 action items (new-session, prev-sessions, quit)
    const actions = items.filter((i) => i.kind === 'action');
    expect(actions).toHaveLength(4); // divider is kind=action
    // Verify action keys
    const keys = items.map((i) => i.key);
    expect(keys).toContain('new-session');
    expect(keys).toContain('prev-sessions');
    expect(keys).toContain('quit');
    expect(keys).toContain('__divider__');
  });

  it('returns project items sorted by lastSeen then name', async () => {
    await writeManifest([
      { name: 'Middle', root: '/a/middle', slug: 'middle-abc', lastSeen: '2025-06-01T00:00:00Z' },
      { name: 'Recent', root: '/a/recent', slug: 'recent-abc', lastSeen: '2025-06-09T00:00:00Z' },
      { name: 'Old', root: '/a/old', slug: 'old-abc', lastSeen: '2025-01-01T00:00:00Z' },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const projects = items.filter((i) => i.kind === 'project');
    expect(projects[0]?.key).toBe('recent-abc');
    expect(projects[1]?.key).toBe('middle-abc');
    expect(projects[2]?.key).toBe('old-abc');
  });

  it('sorts by name when lastSeen is same', async () => {
    await writeManifest([
      { name: 'Charlie', root: '/c', slug: 'charlie', lastSeen: '2025-06-01T00:00:00Z' },
      { name: 'Alpha', root: '/a', slug: 'alpha', lastSeen: '2025-06-01T00:00:00Z' },
      { name: 'Beta', root: '/b', slug: 'beta', lastSeen: '2025-06-01T00:00:00Z' },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const projects = items.filter((i) => i.kind === 'project');
    expect(projects[0]?.key).toBe('alpha');
    expect(projects[1]?.key).toBe('beta');
    expect(projects[2]?.key).toBe('charlie');
  });

  it('marks current project with ● marker', async () => {
    await writeManifest([
      {
        name: 'Current',
        root: '/a/current',
        slug: 'current-abc',
        lastSeen: '2025-06-01T00:00:00Z',
      },
      { name: 'Other', root: '/a/other', slug: 'other-abc', lastSeen: '2025-06-01T00:00:00Z' },
    ]);
    const items = await buildPickerItems({
      globalConfigPath: projectsJsonPath,
      currentProjectRoot: '/a/current',
    });
    const current = items.find((i) => i.key === 'current-abc');
    expect(current?.label).toContain('●');
    const other = items.find((i) => i.key === 'other-abc');
    expect(other?.label).not.toContain('●');
  });

  it('includes subtitle (root path) for each project', async () => {
    await writeManifest([
      { name: 'MyProject', root: '/home/user/code/my-project', slug: 'myproject-abc' },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const p = items.find((i) => i.kind === 'project');
    expect(p?.subtitle).toBe('/home/user/code/my-project');
  });

  it('includes meta (last seen) for each project', async () => {
    await writeManifest([
      { name: 'Fresh', root: '/f', slug: 'fresh-abc', lastSeen: new Date().toISOString() },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const p = items.find((i) => i.kind === 'project');
    // Should show "just now" for a recent timestamp
    expect(p?.meta).toBe('just now');
  });

  it('shows "never" for projects without lastSeen', async () => {
    await writeManifest([{ name: 'NeverSeen', root: '/n', slug: 'never-abc' }]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const p = items.find((i) => i.kind === 'project');
    expect(p?.meta).toBe('never');
  });
});

// ── Integration: filter + buildPickerItems ─────────────────────────────────

describe('integration: buildPickerItems + filterItems', () => {
  it('filtering by project name substring works end-to-end', async () => {
    await writeManifest([
      { name: 'Backend Service', root: '/work/backend', slug: 'backend-abc' },
      { name: 'Frontend App', root: '/work/frontend', slug: 'frontend-abc' },
      { name: 'Mobile App', root: '/work/mobile', slug: 'mobile-abc' },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const filtered = filterItems(items, 'app');
    const projects = filtered.filter((i) => i.kind === 'project');
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.key).sort()).toEqual(['frontend-abc', 'mobile-abc']);
  });

  it('filtering by root path works', async () => {
    await writeManifest([
      { name: 'Service A', root: '/home/alice/project-a', slug: 'a-abc' },
      { name: 'Service B', root: '/home/bob/project-b', slug: 'b-abc' },
    ]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const filtered = filterItems(items, 'alice');
    expect(filtered.filter((i) => i.kind === 'project')).toHaveLength(1);
  });

  it('filtering returns no projects but keeps actions when no match', async () => {
    await writeManifest([{ name: 'Only Project', root: '/only', slug: 'only-abc' }]);
    const items = await buildPickerItems({ globalConfigPath: projectsJsonPath });
    const filtered = filterItems(items, 'zzzz_no_match_at_all');
    expect(filtered.filter((i) => i.kind === 'project')).toHaveLength(0);
    // Action items still present
    expect(filtered.some((i) => i.key === 'new-session')).toBe(true);
    expect(filtered.some((i) => i.key === 'prev-sessions')).toBe(true);
    expect(filtered.some((i) => i.key === 'quit')).toBe(true);
  });
});
