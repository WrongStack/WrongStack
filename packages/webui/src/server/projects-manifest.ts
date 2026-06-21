/**
 * Projects manifest (~/.wrongstack/projects.json) helpers — extracted from the
 * giant startWebUI closure in index.ts. Pure, param-based file IO: each fn
 * takes the global config path explicitly, so they close over nothing. Mirrors
 * the CLI's project-manifest registration (touchProjectInManifest).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { projectSlug } from '@wrongstack/core';

export interface ProjectEntry {
  name: string;
  root: string;
  slug: string;
  lastSeen?: string | undefined;
  createdAt?: string | undefined;
  /** Working directory of the most recent session (may differ from root). */
  lastWorkingDir?: string | undefined;
}

export interface ProjectsManifest {
  projects: ProjectEntry[];
}

export function projectsJsonPath(globalConfigPath: string): string {
  const base = path.dirname(globalConfigPath);
  return path.join(base, 'projects.json');
}

export async function loadManifest(globalConfigPath: string): Promise<ProjectsManifest> {
  try {
    const raw = await fs.readFile(projectsJsonPath(globalConfigPath), 'utf8');
    const parsed = JSON.parse(raw) as ProjectsManifest;
    return { projects: parsed.projects ?? [] };
  } catch {
    return { projects: [] };
  }
}

export async function saveManifest(
  manifest: ProjectsManifest,
  globalConfigPath: string,
): Promise<void> {
  const file = projectsJsonPath(globalConfigPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

export function generateProjectSlug(rootPath: string): string {
  // Canonical derivation — must match wstack-paths/projectSlug exactly or
  // the WebUI and CLI would key the same project under different dirs.
  return projectSlug(rootPath);
}

export async function ensureProjectDataDir(
  slug: string,
  globalConfigPath: string,
): Promise<string> {
  const base = path.dirname(globalConfigPath);
  const dir = path.join(base, 'projects', slug);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
