/**
 * Projects manifest (~/.wrongstack/projects.json) helpers — extracted from the
 * giant startWebUI closure in index.ts. Pure, param-based file IO: each fn
 * takes the global config path explicitly, so they close over nothing. Mirrors
 * the CLI's project-manifest registration (touchProjectInManifest).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigError } from '@wrongstack/contracts/types';
import { projectSlug, withFileLock } from '@wrongstack/core/utils';

export interface ProjectEntry {
  name: string;
  root: string;
  slug: string;
  /** Repo-committed identity shared by clones, worktrees, and machines. */
  projectId?: string | undefined;
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

export async function loadManifest(
  globalConfigPath: string,
  opts: { forWrite?: boolean } = {},
): Promise<ProjectsManifest> {
  try {
    const raw = await fs.readFile(projectsJsonPath(globalConfigPath), 'utf8');
    // An editor's UTF-8 BOM is not corruption (the CLI and boot readers strip it).
    const parsed = JSON.parse(
      raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
    ) as ProjectsManifest;
    return { projects: parsed.projects ?? [] };
  } catch (error) {
    // A caller that writes the manifest back must not treat "unreadable right
    // now" as empty: the write would erase every other registered project.
    // That includes a parse failure, which carries no errno `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (opts.forWrite && code !== 'ENOENT') throw error;
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

/** Register or refresh a project with a serialized read-modify-write. */
export async function touchProjectInManifest(
  options: {
    projectRoot: string;
    workingDir?: string | undefined;
    name?: string | undefined;
  },
  globalConfigPath: string,
): Promise<ProjectEntry> {
  const root = path.resolve(options.projectRoot);
  const file = projectsJsonPath(globalConfigPath);
  let entry: ProjectEntry | undefined;
  await withFileLock(file, async () => {
    const manifest = await loadManifest(globalConfigPath, { forWrite: true });
    const now = new Date().toISOString();
    entry = manifest.projects.find((candidate) => path.resolve(candidate.root) === root);
    if (entry) {
      entry.lastSeen = now;
      if (options.workingDir) entry.lastWorkingDir = path.resolve(options.workingDir);
    } else {
      entry = {
        name: options.name ?? path.basename(root),
        root,
        slug: generateProjectSlug(root),
        createdAt: now,
        lastSeen: now,
        lastWorkingDir: options.workingDir ? path.resolve(options.workingDir) : undefined,
      };
      manifest.projects.push(entry);
    }
    await saveManifest(manifest, globalConfigPath);
  });
  if (!entry) {
    throw new ConfigError({
      message: 'touchProjectInManifest: entry not resolved',
      code: 'CONFIG_INVALID',
      context: { phase: 'manifest-resolve' },
    });
  }
  await ensureProjectDataDir(entry.slug, globalConfigPath);
  return entry;
}
