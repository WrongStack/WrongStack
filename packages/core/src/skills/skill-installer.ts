import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ERROR_CODES, FsError, WrongStackError } from '../types/errors.js';
import type { SkillLoader } from '../types/skill.js';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import { isValidSkillNameFormat, parseSkillFrontmatter } from './frontmatter.js';
import { downloadGitHubTarball, parseSkillRef } from './github-fetcher.js';
import { SKILL_LIMITS } from './limits.js';
import { type InstalledSkillEntry, SkillManifestStore } from './manifest-store.js';
import { githubDirectAdapter } from './registry/github-direct-adapter.js';
import type {
  RegistrySearchOptions,
  RegistrySearchResult,
  RegistrySkillSummary,
  SkillRegistryAdapter,
} from './registry/registry-adapter.js';
export interface SkillInstallerOptions {
  /** Path to the manifest file (~/.wrongstack/installed-skills.json) */
  manifestPath: string;
  /** Path to project-level skills dir (<project>/.wrongstack/skills/) */
  projectSkillsDir: string;
  /** Path to user-global skills dir (~/.wrongstack/skills/) */
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

const MAX_SKILL_FILE_SIZE = SKILL_LIMITS.MAX_SKILL_FILE_SIZE;

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
    opts?: { global?: boolean | undefined },
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
      const skills = await this.detectSkills(tempDir);

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
        // Check for overwrite
        const existing = await this.manifest.findByName(skill.name);
        const existingInScope = existing.find((e) => e.scope === scope);
        if (existingInScope) {
          this.opts.log?.(`Overwriting existing skill "${skill.name}" (${scope})...`);
          await this.removeSkillFiles(skill.name, scope);
        }

        // Copy skill files
        const destDir = path.join(targetDir, skill.name);
        await fs.mkdir(destDir, { recursive: true });
        const copiedFiles: string[] = [];

        for (const file of skill.files) {
          const srcPath = path.join(skill.baseDir, file);
          const destPath = path.join(destDir, file);

          // Path traversal check
          const resolved = path.resolve(destPath);
          if (!resolved.startsWith(path.resolve(destDir))) {
            throw new FsError({
              message: `Path traversal detected in skill file: ${file}`,
              code: ERROR_CODES.FS_DELETE_FAILED,
              path: destPath,
              context: { reason: 'path_traversal', skillName: skill.name },
            });
          }

          // Size check
          const stat = await fs.stat(srcPath);
          if (stat.size > MAX_SKILL_FILE_SIZE) {
            throw new FsError({
              message:
                `Skill file "${file}" is too large (${(stat.size / 1024).toFixed(1)}KB). ` +
                `Max: ${MAX_SKILL_FILE_SIZE / 1024}KB`,
              code: ERROR_CODES.FS_WRITE_FAILED,
              path: srcPath,
              context: { skillName: skill.name, fileSize: stat.size, maxSize: MAX_SKILL_FILE_SIZE },
            });
          }

          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.copyFile(srcPath, destPath);
          copiedFiles.push(file);
        }

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

      const existing = await this.manifest.findByName(fm.name);
      if (existing.find((x) => x.scope === scope)) {
        await this.removeSkillFiles(fm.name, scope);
      }

      const destDir = path.join(targetDir, fm.name);
      await fs.mkdir(destDir, { recursive: true });
      const srcSkillDir = path.join(srcDir, e.name);
      const files = await collectFiles(srcSkillDir, srcSkillDir);
      const copiedFiles: string[] = [];
      for (const file of files) {
        const srcPath = path.join(srcSkillDir, file);
        const destPath = path.join(destDir, file);
        const resolved = path.resolve(destPath);
        if (!resolved.startsWith(path.resolve(destDir))) {
          throw new FsError({
            message: `Path traversal detected in skill file: ${file}`,
            code: ERROR_CODES.FS_DELETE_FAILED,
            path: destPath,
            context: { reason: 'path_traversal', skillName: fm.name },
          });
        }
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        if (opts?.link) {
          try {
            await fs.symlink(srcPath, destPath);
          } catch (err) {
            // Symlink unavailable (e.g. Windows without Developer Mode) — copy.
            await fs.copyFile(srcPath, destPath);
            this.opts.log?.(`symlink failed for ${file} (${toErrorMessage(err)}); copied instead`);
          }
        } else {
          await fs.copyFile(srcPath, destPath);
        }
        copiedFiles.push(file);
      }

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
    _opts?: { global?: boolean | undefined } | undefined,
  ): Promise<UpdateResult> {
    const result: UpdateResult = { updated: [], unchanged: [], errors: [] };
    const allEntries = await this.manifest.listAll();

    let targets: InstalledSkillEntry[];
    if (nameOrRef) {
      // Check if it's a name or a ref (user/repo@ref)
      const byName = allEntries.filter((e) => e.name === nameOrRef);
      if (byName.length > 0) {
        targets = byName;
      } else {
        // Treat as a new ref — find matching source
        try {
          const parsed = parseSkillRef(nameOrRef);
          const source = `github:${parsed.owner}/${parsed.repo}`;
          targets = allEntries.filter((e) => e.source === source);
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
      targets = allEntries;
    }

    // Group by source to avoid downloading the same repo multiple times
    const bySource = new Map<string, InstalledSkillEntry[]>();
    for (const entry of targets) {
      const key = `${entry.source}@${entry.ref}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)?.push(entry);
    }

    for (const [, entries] of bySource) {
      const first = expectDefined(entries[0]);
      const scope = first.scope;
      const isGlobal = scope === 'user';

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
        const results = await this.install(`${sourceRepo}@${refToInstall}`, { global: isGlobal });

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
    const entries = await this.manifest.findByName(name);
    const entry = entries.find((e) => e.scope === scope);

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
    await this.manifest.removeEntry(name, scope);
    this.invalidateLoaderCache();
  }

  /**
   * List all installed skills from the manifest.
   */
  async listInstalled(): Promise<InstalledSkillEntry[]> {
    return this.manifest.listAll();
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
    }
    return dedupeSearchResults(perAdapter);
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Detect skills in an extracted repository.
   * Returns an array of detected skills with their files.
   */
  private async detectSkills(
    baseDir: string,
  ): Promise<Array<{ name: string; baseDir: string; files: string[] }>> {
    const results: Array<{ name: string; baseDir: string; files: string[] }> = [];

    // Check for SKILL.md at root (single-skill repo)
    const rootSkillMd = path.join(baseDir, 'SKILL.md');
    try {
      await fs.access(rootSkillMd);
      const content = await fs.readFile(rootSkillMd, 'utf8');
      const fm = parseSkillFrontmatter(content);
      if (fm.name && fm.description && isValidSkillNameFormat(fm.name)) {
        results.push({
          name: fm.name,
          baseDir,
          files: ['SKILL.md'],
        });
        return results; // Single-skill repo — don't look for skills/
      }
    } catch {
      // No root SKILL.md
    }

    // Check for skills/ subdirectory (multi-skill repo)
    const skillsDir = path.join(baseDir, 'skills');
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillFile, 'utf8');
          const fm = parseSkillFrontmatter(content);
          if (fm.name && fm.description && isValidSkillNameFormat(fm.name)) {
            // Collect all files in the skill directory
            const skillDir = path.join(skillsDir, entry.name);
            const files = await collectFiles(skillDir, skillDir);
            results.push({
              name: fm.name,
              baseDir: skillDir,
              files,
            });
          }
        } catch {
          // Skip malformed skills
        }
      }
    } catch {
      // No skills/ directory
    }

    return results;
  }

  /**
   * Remove all files for an installed skill.
   */
  private async removeSkillFiles(name: string, scope: 'project' | 'user'): Promise<void> {
    const targetDir = scope === 'project' ? this.opts.projectSkillsDir : this.opts.globalSkillsDir;
    const skillDir = path.join(targetDir, name);
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
async function collectFiles(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...(await collectFiles(fullPath, baseDir)));
    } else {
      results.push(relPath);
    }
  }
  return results;
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
