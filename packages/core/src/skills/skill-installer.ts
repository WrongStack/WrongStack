import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ERROR_CODES, FsError, WrongStackError } from '@wrongstack/contracts/types/errors';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import { isValidSkillNameFormat, parseSkillFrontmatter } from './frontmatter.js';
import { downloadGitHubTarball, parseSkillRef } from './github-fetcher.js';
import { type InstalledSkillEntry, SkillManifestStore } from './manifest-store.js';
import { collectSkillFiles, replaceSkillDirectory } from './skill-files.js';

/**
 * Containment check for an extracted archive entry.
 *
 * WS-053: the call sites used a bare `resolved.startsWith(path.resolve(destDir))`,
 * which also accepts a *sibling* whose name merely shares the prefix —
 * `skills/foo` would admit a write to `skills/foo-evil`. Appending the platform
 * separator (and allowing the directory itself) closes that.
 */
function isInside(resolved: string, destDir: string): boolean {
  const root = path.resolve(destDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

import { githubDirectAdapter } from './registry/github-direct-adapter.js';
import type {
  RegistrySearchOptions,
  RegistrySearchResult,
  RegistrySkillSummary,
  SkillRegistryAdapter,
} from './registry/registry-adapter.js';
export interface SkillInstallerOptions {
  /** Path to the profile manifest file (profiles/<name>/installed-skills.json) */
  manifestPath: string;
  /** Path to project-level skills dir (<project>/.wrongstack/skills/) */
  projectSkillsDir: string;
  /** Path to profile skills dir (~/.wrongstack/profiles/<name>/skills/) */
  globalSkillsDir: string;
  /** Current project hash (for manifest tracking) */
  projectHash: string;
  /** Skill loader — cache will be invalidated after mutations */
  skillLoader?: SkillLoader | undefined;
  /** Logger for status messages */
  log?: ((msg: string) => void) | undefined;
  /**
   * Skill registries used to resolve `<adapterId>:<registryId>` refs and to
   * serve `/skill-search`. Defaults to `[githubDirectAdapter]` (the original
   * direct `user/repo` install path). Add a skills.sh adapter to enable
   * searching the marketplace and installing registry hits by id.
   */
  registryAdapters?: SkillRegistryAdapter[] | undefined;
}

export interface InstallResult {
  name: string;
  path: string;
  scope: 'project' | 'user';
  source: string;
  ref: string;
  skillCount: number;
}

export interface UpdateResult {
  updated: Array<{ name: string; oldRef: string; newRef: string }>;
  unchanged: string[];
  errors: Array<{ name: string; error: string }>;
}

export class SkillInstaller {
  private readonly opts: SkillInstallerOptions;
  private readonly manifest: SkillManifestStore;
  private readonly adapters: SkillRegistryAdapter[];

  constructor(opts: SkillInstallerOptions) {
    this.opts = opts;
    this.manifest = new SkillManifestStore(opts.manifestPath);
    this.adapters = opts.registryAdapters?.length ? opts.registryAdapters : [githubDirectAdapter];
  }

  /**
   * Install skills from a skill reference.
   *
   * Accepts two ref formats:
   *   - `user/repo[@ref]`               — direct GitHub install (original path)
   *   - `<adapterId>:<registryId>`      — registry-resolved (e.g.
   *                                       `skills.sh:owner/repo@v1`); the
   *                                       adapter resolves it to a `user/repo`
   *                                       ref and the install proceeds as above.
   *
   * Supports both single-skill repos (SKILL.md at root) and multi-skill repos
   * (skills/ subdirectory). The manifest records the GitHub source as
   * `github:owner/repo` (so `/skill-update` keeps working) plus the originating
   * registry in `registryFrom` when the install came through a registry.
   */
  async install(
    refInput: string,
    /** `only`: restrict to these skill names (update keeps the user's selection). */
    opts?: { global?: boolean | undefined; only?: readonly string[] | undefined },
  ): Promise<InstallResult[]> {
    const resolved = this.resolveRef(refInput);
    const parsed = parseSkillRef(resolved.installRef);
    const scope: 'project' | 'user' = opts?.global ? 'user' : 'project';
    const targetDir = scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    const source = `github:${parsed.owner}/${parsed.repo}`;

    this.opts.log?.(
      resolved.fromRegistry
        ? `Resolving ${refInput} → ${resolved.installRef} (${resolved.adapterId}), downloading...`
        : `Downloading ${parsed.owner}/${parsed.repo}@${parsed.ref}...`,
    );

    const { tempDir } = await downloadGitHubTarball(parsed);

    try {
      // Detect skill structure
      const detected = await this.detectSkills(tempDir, parsed.skillName);
      const skills = detected.filter(
        (skill) =>
          (!parsed.skillName || skill.name === parsed.skillName) &&
          (!opts?.only || opts.only.includes(skill.name)),
      );

      if (skills.length === 0) {
        throw new WrongStackError({
          message:
            'No skills found in repository. Expected SKILL.md at root or skills/ subdirectory.',
          code: ERROR_CODES.VALIDATION_ERROR,
          subsystem: 'general',
          context: { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref },
        });
      }

      const results: InstallResult[] = [];

      for (const skill of skills) {
        const current = (await this.listInstalled()).find(
          (entry) => entry.name === skill.name && entry.scope === scope,
        );
        if (current) this.opts.log?.(`Overwriting existing skill "${skill.name}" (${scope})...`);
        const destDir = path.join(targetDir, skill.name);
        await replaceSkillDirectory(skill.baseDir, destDir, skill.files);
        const copiedFiles = skill.files;

        // Write manifest entry
        const entry: InstalledSkillEntry = {
          name: skill.name,
          source,
          ref: parsed.ref,
          scope,
          projectHash: scope === 'project' ? this.opts.projectHash : undefined,
          installedAt: new Date().toISOString(),
          files: copiedFiles,
          // When the install came through a registry (e.g. skills.sh), record
          // which adapter + registry id resolved to this GitHub repo, so the
          // source is traceable. `source` stays `github:owner/repo` for
          // backward compat with `/skill-update`.
          ...(resolved.fromRegistry
            ? { registryFrom: { adapterId: resolved.adapterId, registryId: resolved.registryId } }
            : {}),
        };
        await this.manifest.addEntry(entry);
        this.invalidateLoaderCache();

        results.push({
          name: skill.name,
          path: destDir,
          scope,
          source,
          ref: parsed.ref,
          skillCount: 1,
        });
      }

      this.invalidateLoaderCache();
      return results;
    } finally {
      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Import skills from a local directory (e.g. `.claude/skills`) into the
   * project or user skills dir, optionally as symlinks. Used by `/skill-import`
   * to take ownership of foreign skills so they can be edited/committed.
   * Each direct subdirectory containing a valid `SKILL.md` is copied verbatim.
   */
  async importFromDir(
    srcDir: string,
    opts?: { global?: boolean | undefined; link?: boolean | undefined },
  ): Promise<InstallResult[]> {
    const scope: 'project' | 'user' = opts?.global ? 'user' : 'project';
    const targetDir = scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      throw new WrongStackError({
        message: `Source directory not found or not readable: ${srcDir}`,
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { srcDir },
      });
    }

    const results: InstallResult[] = [];
    for (const e of entries) {
      if (!(await entryIsDirectory(srcDir, e))) continue;
      const skillMdPath = path.join(srcDir, e.name, 'SKILL.md');
      let content: string;
      try {
        content = await fs.readFile(skillMdPath, 'utf8');
      } catch {
        continue; // subdirectory without a SKILL.md — not a skill
      }
      const fm = parseSkillFrontmatter(content);
      if (!fm.name || !fm.description || !isValidSkillNameFormat(fm.name)) continue;

      const srcSkillDir = path.join(srcDir, e.name);
      const files = await collectFiles(srcSkillDir, srcSkillDir);
      const destDir = path.join(targetDir, fm.name);
      if (path.resolve(destDir) === path.resolve(srcSkillDir))
        throw new Error('Cannot import a skill onto itself');
      await replaceSkillDirectory(srcSkillDir, destDir, files, opts?.link);
      const copiedFiles = files;

      await this.manifest.addEntry({
        name: fm.name,
        source: `import:${srcDir}`,
        ref: '-',
        scope,
        projectHash: scope === 'project' ? this.opts.projectHash : undefined,
        installedAt: new Date().toISOString(),
        files: copiedFiles,
      });
      results.push({
        name: fm.name,
        path: destDir,
        scope,
        source: `import:${srcDir}`,
        ref: '-',
        skillCount: 1,
      });
    }

    this.invalidateLoaderCache();
    return results;
  }

  /**
   * Update installed skills.
   * - No args: update all
   * - Name: update that specific skill
   * - Name + newRef: update to a different ref
   */
  async update(
    nameOrRef?: string | undefined,
    opts?: { global?: boolean | undefined } | undefined,
  ): Promise<UpdateResult> {
    const result: UpdateResult = { updated: [], unchanged: [], errors: [] };
    const allEntries = await this.listInstalled();
    const targetScope = opts?.global !== undefined ? (opts.global ? 'user' : 'project') : undefined;
    const scopedEntries = targetScope
      ? allEntries.filter((e) => e.scope === targetScope)
      : allEntries;

    let targets: InstalledSkillEntry[];
    if (nameOrRef) {
      // Check if it's a name or a ref (user/repo@ref)
      const byName = scopedEntries.filter((e) => e.name === nameOrRef);
      if (byName.length > 0) {
        targets = byName;
      } else {
        // Treat as a new ref — find matching source
        try {
          const parsed = parseSkillRef(nameOrRef);
          const source = `github:${parsed.owner}/${parsed.repo}`;
          targets = scopedEntries.filter((e) => e.source === source);
          if (targets.length === 0) {
            result.errors.push({
              name: nameOrRef,
              error: `No installed skills found matching "${nameOrRef}"`,
            });
            return result;
          }
        } catch {
          result.errors.push({
            name: nameOrRef,
            error: `Invalid reference: ${nameOrRef}`,
          });
          return result;
        }
      }
    } else {
      targets = scopedEntries;
    }

    // Group by scope and source to avoid downloading the same repo multiple times
    const bySource = new Map<string, InstalledSkillEntry[]>();
    for (const entry of targets) {
      const key = `${entry.scope}:${entry.source}@${entry.ref}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)?.push(entry);
    }

    for (const [, entries] of bySource) {
      const first = expectDefined(entries[0]);
      const scope = first.scope;
      const isGlobal = scope === 'user';
      if (!first.source.startsWith('github:')) {
        result.unchanged.push(...entries.map((entry) => entry.name));
        continue;
      }

      try {
        // Parse the original source to get the ref
        const sourceRepo = first.source.replace('github:', '');
        let refToInstall = first.ref;

        // If nameOrRef looks like a new ref, use it
        if (nameOrRef && !allEntries.find((e) => e.name === nameOrRef)) {
          try {
            const parsed = parseSkillRef(nameOrRef);
            refToInstall = parsed.ref;
          } catch {
            // keep original ref
          }
        }

        this.opts.log?.(`Updating ${first.source}@${refToInstall}...`);
        const selectedName =
          nameOrRef && entries.some((entry) => entry.name === nameOrRef) ? nameOrRef : undefined;
        const results = await this.install(
          `${sourceRepo}@${refToInstall}${selectedName ? `#${selectedName}` : ''}`,
          // Only the skills installed from this source: a repo reinstall without
          // a selector would add every sibling the user never chose.
          { global: isGlobal, only: entries.map((entry) => entry.name) },
        );

        for (const r of results) {
          result.updated.push({
            name: r.name,
            oldRef: first.ref,
            newRef: refToInstall,
          });
        }
      } catch (err) {
        const msg = toErrorMessage(err);
        for (const entry of entries) {
          result.errors.push({ name: entry.name, error: msg });
        }
      }
    }

    return result;
  }

  /**
   * Uninstall a skill by name.
   */
  async uninstall(name: string, opts?: { global?: boolean | undefined }): Promise<void> {
    const scope: 'project' | 'user' = opts?.global ? 'user' : 'project';
    this.manifest.invalidateCache();
    const entries = await this.manifest.findByName(name);
    const entry = entries.find((e) => e.scope === scope && this.belongsToCurrentProject(e));

    if (!entry) {
      throw new WrongStackError({
        message: `Skill "${name}" is not installed${scope === 'user' ? ' (global)' : ''}.`,
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { skillName: name, scope },
      });
    }

    // Remove files
    await this.removeSkillFiles(name, scope);

    // Remove from manifest
    await this.manifest.removeEntry(
      name,
      scope,
      scope === 'project' ? this.opts.projectHash : undefined,
    );
    this.invalidateLoaderCache();
  }

  /**
   * List all installed skills from the manifest.
   */
  async listInstalled(): Promise<InstalledSkillEntry[]> {
    this.manifest.invalidateCache();
    return (await this.manifest.listAll()).filter((entry) => this.belongsToCurrentProject(entry));
  }

  /**
   * Search across all configured registry adapters. Results from each adapter
   * are merged (deduplicated by `installRef`, adapters earlier in the list win
   * conflicts). Adapters that don't support search (e.g. github-direct)
   * contribute nothing.
   */
  async search(query: string, opts?: RegistrySearchOptions): Promise<RegistrySearchResult[]> {
    const settled = await Promise.allSettled(this.adapters.map((a) => a.search(query, opts)));
    const perAdapter: RegistrySearchResult[] = [];
    const errors: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') perAdapter.push(s.value);
      else {
        const id = this.adapters[i]?.id ?? '?';
        errors.push(`${id}: ${toErrorMessage(s.reason)}`);
      }
    });
    // Surface adapter errors via the log so a single broken registry doesn't
    // silently hide results — but don't throw, since other adapters may have
    // returned useful results.
    if (errors.length > 0) {
      this.opts.log?.(`Some registries failed during search: ${errors.join('; ')}`);
      if (!perAdapter.some((block) => block.results.length > 0))
        throw new Error(`Skill registry search failed: ${errors.join('; ')}`);
    }
    return dedupeSearchResults(perAdapter);
  }

  private belongsToCurrentProject(entry: InstalledSkillEntry): boolean {
    return entry.scope === 'user' || entry.projectHash === this.opts.projectHash;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Detect skills in an extracted repository.
   * Returns an array of detected skills with their files.
   */
  private async detectSkills(
    baseDir: string,
    selectedName?: string,
  ): Promise<Array<{ name: string; baseDir: string; files: string[] }>> {
    const results: Array<{ name: string; baseDir: string; files: string[] }> = [];

    const readSkill = async (dir: string): Promise<void> => {
      const content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (content === undefined) return;
      const fm = parseSkillFrontmatter(content);
      if (!fm.name || !fm.description || !isValidSkillNameFormat(fm.name)) return;
      if (selectedName && fm.name !== selectedName) return;
      results.push({ name: fm.name, baseDir: dir, files: await collectFiles(dir, dir) });
    };
    await readSkill(baseDir);
    if (results.length) return results;
    const skillsDir = path.join(baseDir, 'skills');
    const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries)
      if (entry.isDirectory()) await readSkill(path.join(skillsDir, entry.name));

    return results;
  }

  /**
   * Remove all files for an installed skill.
   */
  /**
   * Delete an installed skill's directory.
   *
   * The containment check is not ceremonial: this is a `recursive: true,
   * force: true` delete whose target is built from a skill NAME taken from
   * manifest frontmatter. `path.join` normalises `..`, so a crafted name
   * escapes `targetDir` and takes the recursive delete with it. This file
   * already had `isInside` and applied it on the copy path but not here.
   *
   * The strict-subdirectory requirement matters separately: `isInside` allows
   * equality by design, and an empty or `.` name resolves `skillDir` to
   * `targetDir` itself — deleting every installed skill (WS-097).
   */
  private async removeSkillFiles(name: string, scope: 'project' | 'user'): Promise<void> {
    const targetDir = scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    const root = path.resolve(targetDir);
    const skillDir = path.resolve(path.join(targetDir, name));
    if (skillDir === root || !isInside(skillDir, root)) {
      throw new FsError({
        message: `Refusing to delete skill files outside the skills directory: ${name}`,
        code: ERROR_CODES.FS_DELETE_FAILED,
        path: skillDir,
        context: { reason: 'path_traversal', skillName: name, scope },
      });
    }
    await fs.rm(skillDir, { recursive: true, force: true });
  }

  /**
   * Invalidate the skill loader's cache so newly installed skills appear.
   */
  private invalidateLoaderCache(): void {
    // The SkillLoader interface has a cache internally.
    // We access it via the 'any' cast to call invalidateCache if available.
    const loader = this.opts.skillLoader as never as { invalidateCache?: () => void };
    if (loader && typeof loader.invalidateCache === 'function') {
      loader.invalidateCache();
    }
  }

  /**
   * Resolve an install ref, dispatching registry-prefixed refs to the matching
   * adapter. Returns the concrete `user/repo[@ref]` install ref plus provenance
   * (which adapter resolved it, if any).
   */
  private resolveRef(refInput: string): {
    installRef: string;
    fromRegistry: boolean;
    adapterId: string;
    registryId: string;
  } {
    const trimmed = refInput.trim();
    const colonIdx = trimmed.indexOf(':');
    // A colon prefix matches `<adapterId>:<registryId>`. We require the segment
    // before the colon to be a known adapter id so plain `user/repo` refs (and
    // Windows-style `C:\...` paths that should never reach here) aren't
    // misread as registry refs.
    if (colonIdx > 0) {
      const maybeAdapterId = trimmed.slice(0, colonIdx);
      const adapter = this.adapters.find((a) => a.id === maybeAdapterId);
      if (adapter) {
        const registryId = trimmed.slice(colonIdx + 1);
        const installRef = adapter.resolveInstallRef(registryId);
        return { installRef, fromRegistry: true, adapterId: adapter.id, registryId };
      }
    }
    return { installRef: trimmed, fromRegistry: false, adapterId: '', registryId: '' };
  }
}

// ── Utilities ──────────────────────────────────────────────────────

/**
 * True if `entry` is a directory, following symlinks (Claude Code/agents
 * symlink skill dirs — see DefaultSkillLoader.entryIsDirectory).
 */
async function entryIsDirectory(dir: string, entry: import('node:fs').Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return (await fs.stat(path.join(dir, entry.name))).isDirectory();
    } catch {
      return false; // broken symlink
    }
  }
  return false;
}

/**
 * Recursively collect all files in a directory (relative paths).
 */
async function collectFiles(_dir: string, baseDir: string): Promise<string[]> {
  return collectSkillFiles(baseDir);
}

/**
 * Merge per-adapter search results, deduplicating by `installRef`.
 *
 * Two adapters may index the same GitHub repo (e.g. skills.sh and a future
 * internal hub both list `obra/superpowers`). When they do, the first adapter
 * in the configured order wins — its metadata (security score, install count)
 * is the one shown, and the dedup key is the concrete `user/repo[@ref]` so a
 * ref difference still surfaces both. Per-adapter result boundaries are
 * preserved (the caller renders them grouped by adapter).
 */
function dedupeSearchResults(perAdapter: RegistrySearchResult[]): RegistrySearchResult[] {
  const seen = new Set<string>();
  const out: RegistrySearchResult[] = [];
  for (const block of perAdapter) {
    const kept: RegistrySkillSummary[] = [];
    for (const r of block.results) {
      const key = r.installRef;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(r);
    }
    if (kept.length > 0 || block.results.length > 0) {
      out.push({ ...block, results: kept });
    }
  }
  return out;
}
