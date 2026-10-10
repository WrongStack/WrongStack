import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite, projectSlug, wstackGlobalRoot } from '@wrongstack/core/utils';
import type { DesktopProjectEntry } from '../shared/types.js';

export function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function readGlobalProjectManifest(): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  try {
    const raw = await fs.readFile(manifestFile, 'utf8');
    return normalizeProjectManifest(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function normalizeProjectManifest(value: unknown): DesktopProjectEntry[] {
  if (Array.isArray(value)) return normalizeProjectEntries(value).slice(0, 80);
  if (!value || typeof value !== 'object') return [];
  const manifest = value as { projects?: unknown; recentProjects?: unknown; recents?: unknown };
  const source = Array.isArray(manifest.projects)
    ? manifest.projects
    : Array.isArray(manifest.recentProjects)
      ? manifest.recentProjects
      : Array.isArray(manifest.recents)
        ? manifest.recents
        : [];
  return normalizeProjectEntries(source).slice(0, 80);
}

export function normalizeProjectEntries(value: unknown): DesktopProjectEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const projects: DesktopProjectEntry[] = [];
  for (const item of value) {
    const project = normalizeProjectEntry(item);
    if (!project) continue;
    const key = pathKey(project.root);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
  }
  return projects.sort((a, b) =>
    (b.lastSeen ?? b.createdAt ?? '').localeCompare(a.lastSeen ?? a.createdAt ?? ''),
  );
}

function normalizeProjectEntry(value: unknown): DesktopProjectEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DesktopProjectEntry>;
  if (typeof candidate.root !== 'string' || !candidate.root.trim()) return null;
  const root = path.resolve(candidate.root);
  const name =
    typeof candidate.name === 'string' && candidate.name.trim()
      ? candidate.name.trim()
      : path.basename(root) || root;
  const entry: DesktopProjectEntry = {
    name,
    root,
    slug:
      typeof candidate.slug === 'string' && candidate.slug.trim()
        ? candidate.slug.trim()
        : projectSlug(root),
  };
  if (typeof candidate.lastSeen === 'string' && candidate.lastSeen.trim()) {
    entry.lastSeen = candidate.lastSeen.trim();
  }
  if (typeof candidate.createdAt === 'string' && candidate.createdAt.trim()) {
    entry.createdAt = candidate.createdAt.trim();
  }
  if (typeof candidate.lastWorkingDir === 'string' && candidate.lastWorkingDir.trim()) {
    entry.lastWorkingDir = path.resolve(candidate.lastWorkingDir);
  }
  return entry;
}

export async function touchGlobalProjectManifest(
  entry: DesktopProjectEntry,
): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  const projects = await readGlobalProjectManifest();
  const existing = projects.find((p) => samePath(p.root, entry.root));
  if (existing) {
    existing.name = entry.name;
    existing.slug = entry.slug;
    existing.lastSeen = entry.lastSeen;
    existing.lastWorkingDir = entry.lastWorkingDir;
  } else {
    projects.push({ ...entry, createdAt: entry.lastSeen });
  }
  const sorted = projects
    .sort((a, b) =>
      (b.lastSeen ?? b.createdAt ?? '').localeCompare(a.lastSeen ?? a.createdAt ?? ''),
    )
    .slice(0, 80);
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await atomicWrite(manifestFile, `${JSON.stringify({ projects: sorted }, null, 2)}\n`, {
    mode: 0o600,
  });
  return sorted;
}

export async function removeGlobalProjectManifest(
  projectRoot: string,
): Promise<DesktopProjectEntry[]> {
  const manifestFile = path.join(wstackGlobalRoot(), 'projects.json');
  const resolved = path.resolve(projectRoot);
  const projects = (await readGlobalProjectManifest()).filter(
    (project) => !samePath(project.root, resolved),
  );
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await atomicWrite(manifestFile, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  return projects;
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return os.platform() === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
