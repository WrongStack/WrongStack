import { expectDefined } from '../utils/expect-defined.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import { createHash } from 'node:crypto';
import type { WstackPaths } from '../utils/wstack-paths.js';
import type { SyncCategory, SyncConfig } from '../types/config.js';
import { FsError, WrongStackError, ERROR_CODES } from '../types/errors.js';
export const ALL_SYNC_CATEGORIES: SyncCategory[] = [
  'settings',
  'skills',
  'prompts',
  'memory',
  'history',
];

export interface SyncResult {
  ok: boolean;
  action: 'push' | 'pull';
  categories: SyncCategory[];
  committedAt?: string | undefined;
  message: string;
}

type LocalTreeEntry = { path: string; content: string; mode: string };
type GitTreeEntry = LocalTreeEntry | { path: string; sha: null; mode: string };
type RemoteTreeEntry = { path: string; sha: string; type: 'blob' | 'tree' };

interface SyncStateFile {
  version: 1;
  /** Last pushed/pulled commit SHA. */
  sha: string;
  /** Tree SHA paired with `sha`; absent in legacy state files. */
  treeSha?: string | undefined;
  lastSyncedAt: string;
  localRev: string;
}

/**
 * CloudSync — push/pull user-selected ~/.wrongstack categories to a
 * private GitHub repo. No git CLI needed; uses GitHub REST API via fetch.
 * The token is stored encrypted via SecretVault (field named `githubToken`
 * so the vault walker picks it up automatically).
 */
export class CloudSync {
  private readonly statePath: string;
  private state: SyncStateFile | null = null;
  private readonly getSettingsConfigPath: () => string;

  constructor(
    private readonly paths: WstackPaths,
    private readonly getConfig: () => SyncConfig | null,
    private readonly setConfig: (c: SyncConfig) => Promise<void>,
    getSettingsConfigPath?: (() => string) | undefined,
  ) {
    this.statePath = path.join(paths.configDir, 'sync-state.json');
    // Settings belong to the resolved profile. `configDir` is already pinned
    // to that profile, so narrow embedders do not need to implement the named
    // profile resolver and can never silently jump to `default`.
    this.getSettingsConfigPath =
      getSettingsConfigPath ?? (() => path.join(this.paths.configDir, 'config.json'));
  }

  // ── Public API ─────────────────────────────────────────────────────

  async status(): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg?.enabled) {
      return 'CloudSync: disabled. Run `/sync enable` to activate.';
    }
    const last = this.state?.lastSyncedAt;
    const since = last ? timeAgo(last) : 'never';
    return [
      `CloudSync: enabled`,
      `  repo:       ${cfg.repo}`,
      `  categories: ${cfg.categories.join(', ')}`,
      `  last sync:  ${since}`,
    ].join('\n');
  }

  async enable(_repo: string, _categories: SyncCategory[]): Promise<string> {
    // Persisted by the slash command via configStore.update.
    return 'Enable via /sync enable.';
  }

  async disable(): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg) return 'CloudSync is not configured.';
    const next = { ...cfg, enabled: false };
    await this.setConfig(next);
    return 'CloudSync disabled. Local data kept.';
  }

  async push(token: string): Promise<SyncResult> {
    const cfg = this.getConfig();
    if (!cfg?.enabled)
      return { ok: false, action: 'push', categories: [], message: 'Not enabled.' };

    const parts = cfg.repo.split('/');
    const owner = expectDefined(parts[0]);
    const repoName = expectDefined(parts[1]);
    const branch = 'main';
    const remoteHead = await this.getOptionalRef(token, owner, repoName, branch);
    let parentCommitSha = remoteHead?.object?.sha;
    let baseTreeSha: string | undefined;
    let remoteEntries: RemoteTreeEntry[] = [];
    if (parentCommitSha) {
      baseTreeSha =
        parentCommitSha === this.state?.sha && this.state.treeSha
          ? this.state.treeSha
          : (await this.getCommit(token, owner, repoName, parentCommitSha)).tree.sha;
      remoteEntries = await this.getTreeEntries(token, owner, repoName, baseTreeSha);
    }

    const { treeEntries: localEntries, rev } = await this.buildLocalTree(cfg.categories);
    let treeEntries = this.buildPushTree(localEntries, remoteEntries, cfg.categories);
    let newTreeSha = await this.createGitTree(token, owner, repoName, treeEntries, baseTreeSha);

    let commitSha = await this.createCommit(
      token,
      owner,
      repoName,
      newTreeSha,
      parentCommitSha,
      `Sync ${cfg.categories.join(', ')} — ${new Date().toISOString()}`,
    );

    try {
      if (parentCommitSha) {
        await this.updateRef(token, owner, repoName, branch, commitSha);
      } else {
        await this.createRef(token, owner, repoName, branch, commitSha);
      }
    } catch (err) {
      // 422 = not a fast forward — remote branch moved. Fetch latest SHA and retry.
      if (err instanceof Error && err.message.includes('422')) {
        const remote = await this.getRef(token, owner, repoName, branch);
        parentCommitSha = remote.object.sha;
        baseTreeSha = (await this.getCommit(token, owner, repoName, parentCommitSha)).tree.sha;
        // Rebuild on the latest remote tree so concurrent files/categories are
        // preserved and deletions are recalculated after the conflict.
        remoteEntries = await this.getTreeEntries(token, owner, repoName, baseTreeSha);
        treeEntries = this.buildPushTree(localEntries, remoteEntries, cfg.categories);
        newTreeSha = await this.createGitTree(token, owner, repoName, treeEntries, baseTreeSha);
        commitSha = await this.createCommit(
          token,
          owner,
          repoName,
          newTreeSha,
          parentCommitSha,
          `Sync ${cfg.categories.join(', ')} — ${new Date().toISOString()}`,
        );
        await this.updateRef(token, owner, repoName, branch, commitSha);
      } else {
        throw err;
      }
    }

    const syncState: SyncStateFile = {
      version: 1,
      sha: commitSha,
      treeSha: newTreeSha,
      lastSyncedAt: new Date().toISOString(),
      localRev: rev,
    };
    await atomicWrite(this.statePath, JSON.stringify(syncState, null, 2));
    this.state = syncState;

    return {
      ok: true,
      action: 'push',
      categories: cfg.categories,
      committedAt: commitSha,
      message: `Pushed ${cfg.categories.join(', ')} to ${cfg.repo}. Commit: ${commitSha.slice(0, 7)}`,
    };
  }

  async pull(token: string): Promise<SyncResult> {
    const cfg = this.getConfig();
    if (!cfg?.enabled)
      return { ok: false, action: 'pull', categories: [], message: 'Not enabled.' };

    const pullParts = cfg.repo.split('/');
    const owner = expectDefined(pullParts[0]);
    const repoName = expectDefined(pullParts[1]);

    const branchData = await this.getRef(token, owner, repoName, 'main');
    const currentSha = branchData.object.sha;

    const commitData = await this.getCommit(token, owner, repoName, currentSha);
    const treeSha = commitData.tree.sha;

    const treeEntries = await this.getTreeEntries(token, owner, repoName, treeSha);

    for (const entry of treeEntries) {
      if (entry.type !== 'blob') continue;

      // Paths look like "data/{category}/..." — extract the category
      const segments = entry.path.split('/');
      if (segments[0] !== 'data' || !segments[1]) continue;
      const cat = segments[1] as SyncCategory;
      if (!ALL_SYNC_CATEGORIES.includes(cat) || !cfg.categories.includes(cat)) continue;

      const localPath = this.categoryToPath(cat);
      if (!localPath) continue;

      // Reconstruct relative path under the category dir. Remote trees are
      // untrusted input: a compromised sync repo could contain paths like
      // data/skills/../../config.json. Keep every write inside the selected
      // category root, and only allow subpaths for directory-backed categories.
      const rel = segments.slice(2).join('/');
      const destPath = resolvePulledCategoryPath(cat, localPath, rel, entry.path);

      await preparePulledDestination(cat, localPath, destPath, entry.path);
      const blobData = await this.getBlob(token, owner, repoName, entry.sha);
      // Atomic write: pulled blobs land on live files (config.json, memory,
      // history). A bare writeFile truncated by a crash/ENOSPC mid-write would
      // corrupt the live file; atomicWrite writes a temp + fsync + rename.
      await atomicWrite(destPath, Buffer.from(blobData, 'base64'));
    }

    const localRev = await this.hashLocalCategories(cfg.categories);
    const syncState: SyncStateFile = {
      version: 1,
      sha: currentSha,
      treeSha,
      lastSyncedAt: new Date().toISOString(),
      localRev,
    };
    await atomicWrite(this.statePath, JSON.stringify(syncState, null, 2));
    this.state = syncState;

    return {
      ok: true,
      action: 'pull',
      categories: cfg.categories,
      committedAt: currentSha,
      message: `Pulled ${cfg.categories.join(', ')} from ${cfg.repo}. Commit: ${currentSha.slice(0, 7)}`,
    };
  }

  async hasLocalChanges(): Promise<boolean> {
    if (!this.state) return true;
    const cfg = this.getConfig();
    if (!cfg) return true;
    const current = await this.hashLocalCategories(cfg.categories);
    return current !== this.state.localRev;
  }

  async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      this.state = JSON.parse(raw) as SyncStateFile;
    } catch {
      this.state = null;
    }
  }

  // ── GitHub API helpers ──────────────────────────────────────────────

  private async githubFetch(
    token: string,
    owner: string,
    repo: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    pathSegment: string,
    body?: unknown | undefined,
  ): Promise<unknown> {
    const url = `https://api.github.com/repos/${owner}/${repo}${pathSegment}`;
    const init: RequestInit = {
      signal: AbortSignal.timeout(15_000),
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);

    if (!res.ok) {
      const errText = await res.text();
      throw new WrongStackError({
        message: `GitHub API ${method} ${pathSegment} failed (${res.status}): ${errText}`,
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
        context: { method, pathSegment, status: res.status, repo: `${owner}/${repo}` },
      });
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  private async getRef(token: string, owner: string, repo: string, ref: string) {
    return (await this.githubFetch(token, owner, repo, 'GET', `/git/refs/heads/${ref}`)) as {
      object: { sha: string };
    };
  }

  private async getOptionalRef(token: string, owner: string, repo: string, ref: string) {
    try {
      return await this.getRef(token, owner, repo, ref);
    } catch (err) {
      if (err instanceof Error && err.message.includes('failed (404)')) return null;
      if (err instanceof Error && err.message.includes('failed (409)')) {
        throw new WrongStackError({
          message:
            'GitHub repository is empty. Initialize it with a README or first commit, then retry `/sync push`.',
          code: ERROR_CODES.UNKNOWN,
          subsystem: 'general',
          context: { repo: `${owner}/${repo}`, ref },
          cause: err,
        });
      }
      throw err;
    }
  }

  private async createRef(token: string, owner: string, repo: string, ref: string, sha: string) {
    await this.githubFetch(token, owner, repo, 'POST', '/git/refs', {
      ref: `refs/heads/${ref}`,
      sha,
    });
  }

  private async updateRef(token: string, owner: string, repo: string, ref: string, sha: string) {
    await this.githubFetch(token, owner, repo, 'PATCH', `/git/refs/heads/${ref}`, {
      sha,
      force: false,
    });
  }

  private async getCommit(token: string, owner: string, repo: string, sha: string) {
    return (await this.githubFetch(token, owner, repo, 'GET', `/git/commits/${sha}`)) as {
      tree: { sha: string };
      message: string;
    };
  }

  private async getTreeEntries(
    token: string,
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<RemoteTreeEntry[]> {
    // GitHub returns `{ sha, tree: [...], truncated }`, NOT a bare array — the
    // previous cast made `for (const entry of ...)` throw "not iterable", so
    // pull never actually ran. Unwrap `.tree`, and refuse a truncated result
    // rather than silently syncing a partial file set.
    const res = (await this.githubFetch(
      token,
      owner,
      repo,
      'GET',
      `/git/trees/${treeSha}?recursive=1`,
    )) as {
      tree?: Array<{ path: string; sha: string; type: 'blob' | 'tree' }>;
      truncated?: boolean;
    };
    if (res.truncated) {
      throw new WrongStackError({
        message: 'Sync tree is too large — GitHub truncated the result; refusing a partial pull.',
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
      });
    }
    return res.tree ?? [];
  }

  private async createCommit(
    token: string,
    owner: string,
    repo: string,
    treeSha: string,
    parentSha?: string | undefined,
    message = 'sync',
  ) {
    const body: Record<string, unknown> = { message, tree: treeSha };
    if (parentSha) body.parents = [parentSha];
    const result = (await this.githubFetch(token, owner, repo, 'POST', '/git/commits', body)) as {
      sha: string;
    };
    return result.sha;
  }

  private async createGitTree(
    token: string,
    owner: string,
    repo: string,
    entries: GitTreeEntry[],
    baseTreeSha?: string | undefined,
  ): Promise<string> {
    const tree = entries.map((entry) =>
      'sha' in entry
        ? { path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha }
        : { path: entry.path, mode: entry.mode, type: 'blob', content: entry.content },
    );
    const body: Record<string, unknown> = { tree };
    if (baseTreeSha) body.base_tree = baseTreeSha;
    const result = (await this.githubFetch(token, owner, repo, 'POST', '/git/trees', body)) as {
      sha: string;
    };
    return result.sha;
  }

  private async getBlob(token: string, owner: string, repo: string, sha: string): Promise<string> {
    const result = (await this.githubFetch(token, owner, repo, 'GET', `/git/blobs/${sha}`)) as {
      content: string;
    };
    return result.content;
  }

  // ── Local file helpers ──────────────────────────────────────────────

  private buildPushTree(
    localEntries: LocalTreeEntry[],
    remoteEntries: RemoteTreeEntry[],
    categories: SyncCategory[],
  ): GitTreeEntry[] {
    const selected = new Set(categories.map((category) => `data/${category}`));
    const localPaths = new Set(localEntries.map((entry) => entry.path));
    const deletions: GitTreeEntry[] = [];
    for (const entry of remoteEntries) {
      if (entry.type !== 'blob' || localPaths.has(entry.path)) continue;
      const selectedCategory = [...selected].some(
        (prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`),
      );
      if (selectedCategory) deletions.push({ path: entry.path, sha: null, mode: '100644' });
    }
    return [...localEntries, ...deletions];
  }

  private async buildLocalTree(categories: SyncCategory[]): Promise<{
    treeEntries: LocalTreeEntry[];
    rev: string;
  }> {
    const entries: Array<{ path: string; content: string; mode: string }> = [];
    const hashes: string[] = [];

    for (const cat of categories) {
      const localPath = this.categoryToPath(cat);
      if (!localPath) continue;
      try {
        const stat = await fs.lstat(localPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          const files = await this.walkDir(localPath, localPath);
          for (const file of files) {
            const content = await fs.readFile(file, 'utf8');
            const rel = path.relative(localPath, file).replace(/\\/g, '/');
            entries.push({ path: `data/${cat}/${rel}`, content, mode: '100644' });
            hashes.push(`${cat}/${rel}\0${content}`);
          }
        } else {
          const content = await fs.readFile(localPath, 'utf8');
          entries.push({ path: `data/${cat}`, content, mode: '100644' });
          hashes.push(`${cat}\0${content}`);
        }
      } catch {
        // skip missing files/dirs
      }
    }

    const rev = createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 12);
    return { treeEntries: entries, rev };
  }

  private async hashLocalCategories(categories: SyncCategory[]): Promise<string> {
    const hashes: string[] = [];
    for (const cat of categories) {
      const localPath = this.categoryToPath(cat);
      if (!localPath) continue;
      try {
        const stat = await fs.lstat(localPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          const files = await this.walkDir(localPath, localPath);
          for (const file of files) {
            const content = await fs.readFile(file, 'utf8');
            const rel = path.relative(localPath, file).replace(/\\/g, '/');
            hashes.push(`${cat}/${rel}\0${content}`);
          }
        } else {
          const content = await fs.readFile(localPath, 'utf8');
          hashes.push(`${cat}\0${content}`);
        }
      } catch {
        // skip
      }
    }
    return createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 12);
  }

  private categoryToPath(cat: SyncCategory): string | null {
    switch (cat) {
      case 'settings':
        return this.getSettingsConfigPath();
      case 'skills':
        return this.paths.globalSkills;
      case 'prompts':
        return this.paths.globalPrompts;
      case 'memory':
        return this.paths.globalMemory;
      case 'history':
        return this.paths.historyFile;
      /* v8 ignore next -- unreachable: SyncCategory is exhaustively matched above */
      default:
        return null;
    }
  }

  private async walkDir(dir: string, base: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        results.push(...(await this.walkDir(full, base)));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
    return results;
  }
}

async function preparePulledDestination(
  cat: SyncCategory,
  localPath: string,
  destPath: string,
  remotePath: string,
): Promise<void> {
  const directoryBacked = cat === 'skills' || cat === 'prompts';
  const rootPath = directoryBacked ? localPath : path.dirname(localPath);
  const rootStat = await lstatIfExists(rootPath);
  if (rootStat?.isSymbolicLink()) {
    throw unsafePulledSymlinkError(remotePath, rootPath);
  }

  if (directoryBacked) {
    const relativeParent = path.relative(rootPath, path.dirname(destPath));
    let cursor = rootPath;
    if (relativeParent) {
      for (const segment of relativeParent.split(path.sep)) {
        cursor = path.join(cursor, segment);
        const stat = await lstatIfExists(cursor);
        if (stat?.isSymbolicLink()) throw unsafePulledSymlinkError(remotePath, cursor);
      }
    }
  }

  const destStat = await lstatIfExists(destPath);
  if (destStat?.isSymbolicLink()) throw unsafePulledSymlinkError(remotePath, destPath);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
}

async function lstatIfExists(
  filePath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function unsafePulledSymlinkError(remotePath: string, symlinkPath: string): FsError {
  return new FsError({
    message: `Refusing CloudSync write through symlink: ${remotePath}`,
    code: ERROR_CODES.FS_DELETE_FAILED,
    path: remotePath,
    context: { reason: 'symlink_destination', symlinkPath },
  });
}

function resolvePulledCategoryPath(
  cat: SyncCategory,
  localPath: string,
  rel: string,
  remotePath: string,
): string {
  const directoryBacked = cat === 'skills' || cat === 'prompts';
  if (!directoryBacked) {
    if (rel)
      throw new FsError({
        message: `Refusing nested CloudSync path for file category: ${remotePath}`,
        code: ERROR_CODES.FS_DELETE_FAILED,
        path: remotePath,
        context: { reason: 'nested_file_category', category: cat },
      });
    return localPath;
  }

  if (!rel) return localPath;
  const normalizedRel = path.normalize(rel);
  const traversesUp = normalizedRel === '..' || normalizedRel.startsWith(`..${path.sep}`);
  if (path.isAbsolute(normalizedRel) || traversesUp) {
    throw new FsError({
      message: `Refusing CloudSync path traversal: ${remotePath}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: remotePath,
      context: { reason: 'path_traversal', normalizedRel },
    });
  }

  const dest = path.resolve(localPath, normalizedRel);
  const root = path.resolve(localPath);
  const relative = path.relative(root, dest);
  // On POSIX, a backslash is not a path separator, so an input such as
  // `..\\secret` reaches this containment check even though the first guard
  // rejects ordinary `../secret` traversal.
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FsError({
      message: `Refusing CloudSync path outside category root: ${remotePath}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: remotePath,
      context: { reason: 'outside_category_root', category: cat },
    });
  }
  return dest;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
