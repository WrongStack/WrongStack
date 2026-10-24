import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { atomicWrite, withFileLock } from './utils/atomic-write.js';
import { toErrorMessage } from './utils/error.js';
import type { WstackPaths } from './utils/wstack-paths.js';

/**
 * Refuse to boot when the resolved project root lives inside
 * `<globalRoot>/projects` — the per-project state namespace WrongStack itself
 * owns (`~/.wrongstack/projects/<slug>`, or under `WRONGSTACK_HOME`).
 *
 * When this happens it means a caller spawned a WrongStack process with a
 * state path as its cwd; `DefaultPathResolver` then finds no project marker,
 * walks up, hits the home-directory stop, and falls back to cwd — so the state
 * directory itself becomes the "project". Boot would go on to register a
 * nested slug (`<slug>-<hash>`) with its own `meta.json`, `projects.json`
 * entry, mailbox lock and token, splitting coordination state across two
 * namespaces — with the nested one always winning `lastSeen`.
 *
 * Deliberately scoped to `projects/` rather than all of `globalRoot`: a user
 * may legitimately point `WRONGSTACK_HOME` at a directory that also contains
 * real repositories (our own bridge tests do exactly this), and refusing those
 * would be a false positive. Nothing under `projects/` is ever a real repo, so
 * the narrow check has no such ambiguity.
 *
 * Loud on purpose — the symptom is far harder to diagnose than a refused boot
 * that names the offending directory.
 */
export function assertProjectRootOutsideStateDir(projectRoot: string, globalRoot: string): void {
  const stateNamespace = path.resolve(globalRoot, 'projects');
  const rel = path.relative(stateNamespace, path.resolve(projectRoot));
  // Outside → the relative path escapes upward, or is absolute (other drive).
  // Canonical escape test: `..hidden` is a legal in-root first segment; a bare
  // startsWith('..') misread it as outside and let a state-dir projectRoot
  // boot.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
  // `rel === ''` means projectRoot IS `projects/`; anything else is nested.
  throw new Error(
    `Refusing to start: the resolved project root is inside WrongStack's per-project ` +
      `state directory.\n` +
      `  project root: ${projectRoot}\n` +
      `  state dir:    ${stateNamespace}\n` +
      `This usually means a WrongStack process was spawned with a state path as its ` +
      `working directory. Start from a real project directory, or pass --cwd <path>.`,
  );
}

export async function writeProjectMeta(
  paths: WstackPaths,
  projectRoot: string,
  projectId?: string,
): Promise<void> {
  try {
    await fs.mkdir(paths.projectDir, { recursive: true });
    const meta = {
      hash: paths.projectHash,
      slug: paths.projectSlug,
      root: projectRoot,
      ...(projectId ? { projectId } : {}),
      lastSeen: new Date().toISOString(),
    };
    await atomicWrite(paths.projectMeta, JSON.stringify(meta, null, 2));
  } catch {
    // best-effort
  }
}

/**
 * Register or update the current project in ~/.wrongstack/projects.json.
 * This is the central manifest that the /project command uses.
 */
export async function registerProjectInManifest(
  paths: WstackPaths,
  projectRoot: string,
  events?: EventBus,
  /** Working directory when it differs from projectRoot (e.g. subdirectory launch). */
  workingDir?: string,
  /** Stable repo-committed identity shared by clones and worktrees. */
  projectId?: string,
): Promise<void> {
  const manifestPath = path.join(paths.globalRoot, 'projects.json');

  // Read existing manifest (best-effort — missing or malformed file is treated as empty)
  try {
    const t0 = Date.now();
    const raw = await fs.readFile(manifestPath, 'utf8');
    events?.emit('storage.read', {
      sessionId: '~boot~',
      store: 'project',
      filePath: manifestPath,
      operation: 'manifest_read',
      outcome: 'success',
      durationMs: Date.now() - t0,
    });
    try {
      JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); // validate
    } catch {
      // treat malformed JSON as empty manifest — will be overwritten
    }
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: '~boot~',
      store: 'project',
      filePath: manifestPath,
      operation: 'manifest_read',
      error: toErrorMessage(err),
      recoverable: true,
    });
  }

  // Write updated manifest. Under the manifest lock: every boot rewrites this
  // file, and two sessions starting at once each dropped the other's project.
  try {
    await withFileLock(manifestPath, async () => {
      let manifest: {
        projects: Array<{
          name: string;
          root: string;
          slug: string;
          projectId?: string;
          lastSeen?: string;
          createdAt?: string;
          lastWorkingDir?: string;
        }>;
      };
      let raw: string | undefined;
      try {
        raw = await fs.readFile(manifestPath, 'utf8');
      } catch (err) {
        // Only a missing manifest starts empty: on any other read error the
        // write below would erase every other registered project.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      try {
        // An editor's UTF-8 BOM is not corruption: the /project picker reads it
        // fine, and treating it as malformed rewrote the manifest with only this
        // project, erasing every other registered one on the next boot.
        manifest =
          raw === undefined
            ? { projects: [] }
            : JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      } catch {
        manifest = { projects: [] };
      }

      const now = new Date().toISOString();
      const existing = manifest.projects.find((p) => p.root === projectRoot);
      if (existing) {
        existing.lastSeen = now;
        if (projectId) existing.projectId = projectId;
        if (workingDir) existing.lastWorkingDir = workingDir;
      } else {
        const slug = paths.projectSlug;
        const name = path.basename(projectRoot);
        const entry: Record<string, string | undefined> = {
          name,
          root: projectRoot,
          slug,
          projectId,
          lastSeen: now,
          createdAt: now,
        };
        if (workingDir) entry.lastWorkingDir = workingDir;
        manifest.projects.push(entry as (typeof manifest.projects)[0]);
      }

      const writeT0 = Date.now();
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
      events?.emit('storage.write', {
        sessionId: '~boot~',
        store: 'project',
        filePath: manifestPath,
        operation: 'manifest_write',
        outcome: 'success',
        durationMs: Date.now() - writeT0,
      });
    });
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: '~boot~',
      store: 'project',
      filePath: manifestPath,
      operation: 'manifest_write',
      error: toErrorMessage(err),
      recoverable: false,
    });
    // best-effort — never blocks boot
  }
}

/**
 * Remove project directories that can no longer describe a real project:
 * those whose original `root` is gone from disk (temp dirs from tests,
 * deleted working copies), and phantom *nested* projects whose `root` points
 * back inside the state namespace.
 *
 * The nested case is the residue of the bug `assertProjectRootOutsideStateDir`
 * now refuses at boot: a process started with a state path as its cwd
 * registered `<slug>-<hash>` whose `root` is `<globalRoot>/projects/<slug>`.
 * The guard stops new ones, but it cannot retire the ones already on disk —
 * and the existing "root is gone" rule never matches them, because their root
 * is a directory that very much still exists. They therefore persisted
 * indefinitely, each one doubling a real project's footprint: its own
 * `meta.json`, mailbox lock, token, and — because callers enumerate this
 * directory — its own spawned daemon.
 *
 * Safe to delete unconditionally: nothing under `projects/` is ever a real
 * repository, which is the same reasoning that lets the boot guard scope
 * itself to that subtree.
 *
 * Runs as a fire-and-forget best-effort — failures are silently ignored.
 *
 * @internal Exported for tests: this recursively deletes directories, so its
 * keep/delete decision is worth pinning directly rather than through `boot()`.
 */
export async function cleanupStaleProjects(wpaths: WstackPaths): Promise<void> {
  const projectsRoot = path.dirname(wpaths.projectDir);
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist or can't be read
  }
  const stateNamespace = path.resolve(projectsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, entry.name);
    const metaPath = path.join(projectPath, 'meta.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as { root?: string | undefined };
      if (typeof meta.root !== 'string') continue;
      const rel = path.relative(stateNamespace, path.resolve(meta.root));
      // Canonical escape test: `..hidden` is a legal in-root first segment; a
      // bare startsWith('..') misread nested phantoms under such dirs as
      // legitimate and skipped their cleanup.
      const nested = rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
      if (nested) {
        // Phantom project registered from a state path — never legitimate.
        await fs.rm(projectPath, { recursive: true, force: true });
        continue;
      }
      try {
        await fs.access(meta.root);
        // root still exists — keep it
      } catch {
        // root gone → remove the entire project directory
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    } catch {
      // no readable meta.json → leave it alone (don't nuke ambiguous dirs)
    }
  }
}
