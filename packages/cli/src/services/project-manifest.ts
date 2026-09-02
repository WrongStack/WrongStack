import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigError } from '@wrongstack/core/types';
import { readProjectIdentity, withFileLock, wstackGlobalRoot } from '@wrongstack/core/utils';

// Shared project-manifest types and persistence.

export interface ProjectEntry {
  /** User-friendly name (defaults to dirname, can be renamed). */
  name: string;
  /** Absolute path to the project root. */
  root: string;
  /** Stable unique slug (dirname-hash) for per-project data storage. */
  slug: string;
  /** Repo-committed identity shared by clones, worktrees, and machines. */
  projectId?: string | undefined;
  /** ISO timestamp of last use. */
  lastSeen?: string | undefined;
  /** ISO timestamp of when the project was first registered. */
  createdAt?: string | undefined;
  /** Working directory of the most recent session (may differ from root). */
  lastWorkingDir?: string | undefined;
}

export interface ProjectsManifest {
  projects: ProjectEntry[];
}

// ── Path resolution ───────────────────────────────────────────────────

function projectsJsonPath(globalConfigPath?: string | undefined): string {
  const base = globalConfigPath ? path.dirname(globalConfigPath) : wstackGlobalRoot();
  return path.join(base, 'projects.json');
}

function projectsDataDir(globalConfigPath?: string | undefined): string {
  const base = globalConfigPath ? path.dirname(globalConfigPath) : wstackGlobalRoot();
  return path.join(base, 'projects');
}

// ── Read / Write manifest ─────────────────────────────────────────────

export async function loadManifest(
  globalConfigPath?: string | undefined,
): Promise<ProjectsManifest> {
  const file = projectsJsonPath(globalConfigPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] };
    throw new ConfigError({
      message: `Unable to read projects manifest: ${file}`,
      code: 'CONFIG_INVALID',
      context: { file, phase: 'manifest-read' },
      cause: error,
    });
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as ProjectsManifest).projects)
    ) {
      throw new Error('projects must be an array');
    }
    return { projects: (parsed as ProjectsManifest).projects };
  } catch (error) {
    throw new ConfigError({
      message: `Unable to parse projects manifest: ${file}`,
      code: 'CONFIG_PARSE_FAILED',
      context: { file, phase: 'manifest-parse' },
      cause: error,
    });
  }
}

export async function saveManifest(
  manifest: ProjectsManifest,
  globalConfigPath?: string | undefined,
): Promise<void> {
  const file = projectsJsonPath(globalConfigPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Generate a unique slug from a project root path.
 */
export function generateSlug(root: string): string {
  const base =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/**
 * Find a project entry by slug, name, or root (partial match).
 */
export function findProject(manifest: ProjectsManifest, query: string): ProjectEntry | undefined {
  const lower = query.toLowerCase();
  // Exact slug match first
  let found = manifest.projects.find((p) => p.slug === lower);
  if (found) return found;
  // Name match
  found = manifest.projects.find((p) => p.name.toLowerCase() === lower);
  if (found) return found;
  // Root ends-with match
  found = manifest.projects.find((p) => p.root.toLowerCase().endsWith(lower));
  if (found) return found;
  // Root contains match
  found = manifest.projects.find((p) => p.root.toLowerCase().includes(lower));
  return found;
}

/**
 * Ensure the per-project data directory exists under ~/.wrongstack/projects/<slug>/.
 */
export async function ensureProjectDataDir(
  slug: string,
  globalConfigPath?: string | undefined,
): Promise<string> {
  const dir = path.join(projectsDataDir(globalConfigPath), slug);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Idempotent project registration: ensure `projectRoot` has an entry in
 * projects.json, creating one when missing and refreshing `lastSeen` /
 * `lastWorkingDir` when present. Returns the (created or updated) entry.
 *
 * Every surface that opens a project (CLI/TUI boot, standalone WebUI boot,
 * WebUI projects.select) funnels through this so the manifest is the single
 * source of truth for "which projects exist" regardless of entry point.
 * Concurrent processes booting on the same machine serialize via a file
 * lock around the read-modify-write.
 */
export async function touchProjectInManifest(opts: {
  projectRoot: string;
  globalConfigPath?: string | undefined;
  /** Working dir of this session when it differs from the root. */
  workingDir?: string | undefined;
  /** Friendly name for a NEWLY created entry (default: basename). */
  name?: string | undefined;
}): Promise<ProjectEntry> {
  const root = path.resolve(opts.projectRoot);
  const projectId = (await readProjectIdentity(root).catch(() => undefined))?.projectId;
  const file = projectsJsonPath(opts.globalConfigPath);
  let entry: ProjectEntry | undefined;
  await withFileLock(file, async () => {
    const manifest = await loadManifest(opts.globalConfigPath);
    const now = new Date().toISOString();
    entry = manifest.projects.find((p) => path.resolve(p.root) === root);
    if (entry) {
      entry.lastSeen = now;
      if (projectId) entry.projectId = projectId;
      if (opts.workingDir) entry.lastWorkingDir = path.resolve(opts.workingDir);
    } else {
      entry = {
        name: opts.name ?? path.basename(root),
        root,
        slug: generateSlug(root),
        projectId,
        createdAt: now,
        lastSeen: now,
        lastWorkingDir: opts.workingDir ? path.resolve(opts.workingDir) : undefined,
      };
      manifest.projects.push(entry);
    }
    await saveManifest(manifest, opts.globalConfigPath);
  });
  await ensureProjectDataDir(expectEntry(entry).slug, opts.globalConfigPath);
  return expectEntry(entry);
}

function expectEntry(e: ProjectEntry | undefined): ProjectEntry {
  if (!e)
    throw new ConfigError({
      message: 'touchProjectInManifest: entry not resolved',
      code: 'CONFIG_INVALID',
      context: { phase: 'manifest-resolve' },
    });
  return e;
}
