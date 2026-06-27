import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Path layout. All developer-level state lives in ~/.wrongstack/.
 * Per-project state is keyed by sha256(absoluteProjectRoot).slice(0,12)
 * under ~/.wrongstack/projects/<hash>/.
 *
 * The ONLY thing inside the project tree is the optional
 * .wrongstack/AGENTS.md (committed) and .wrongstack/skills/ (committed).
 */

export interface WstackPaths {
  /** ~/.wrongstack — global root. */
  globalRoot: string;
  /**
   * ~/.wrongstack — directory for user-global stateful config files
   * (mode.json, theme.json, …). Currently an alias for `globalRoot`;
   * separate name lets us split out per-OS XDG_CONFIG_HOME later
   * without rewriting callers.
   */
  configDir: string;
  /** ~/.wrongstack/config.json */
  globalConfig: string;
  /** ~/.wrongstack/.key — 32 random bytes, mode 0600, AES-GCM key for the secret vault. */
  secretsKey: string;
  /** ~/.wrongstack/memory.md — user-global memory. */
  globalMemory: string;
  /** ~/.wrongstack/skills — user-global skills. */
  globalSkills: string;
  /** ~/.wrongstack/design-kits — user-global Design Studio kits. */
  globalDesignKits: string;
  /** ~/.wrongstack/prompts — user-global prompt library. */
  globalPrompts: string;
  /** ~/.wrongstack/cache — fetched data (models.dev, etc.). */
  cacheDir: string;
  /** ~/.wrongstack/cache/models.dev.json */
  modelsCache: string;
  /** ~/.wrongstack/cache/models-overlay.json — cached curated overlay. */
  modelsOverlayCache: string;
  /**
   * Per-project codebase symbol index (SQLite). Lives under the global project
   * dir — NOT inside the repo — so it never clutters the working tree or needs
   * gitignoring. `~/.wrongstack/projects/<hash>/codebase-index`.
   */
  projectCodebaseIndex: string;
  /** ~/.wrongstack/history — REPL line history. */
  historyFile: string;
  /** ~/.wrongstack/logs/wrongstack.log */
  logFile: string;
  /** ~/.wrongstack/projects/<hash> */
  projectDir: string;
  /** ~/.wrongstack/projects/<hash>/memory.md */
  projectMemory: string;
  /** ~/.wrongstack/projects/<hash>/sessions */
  projectSessions: string;
  /** ~/.wrongstack/projects/<hash>/trust.json */
  projectTrust: string;
  /** ~/.wrongstack/projects/<hash>/meta.json */
  projectMeta: string;
  /** ~/.wrongstack/projects/<hash>/config.local.json — optional override */
  projectLocalConfig: string;
  /** <project>/.wrongstack/config.json — per-project settings (safe fields only).
   *  This lives inside the project root so it can be gitignored or shared. */
  inProjectConfig: string;
  /** <project>/.wrongstack/AGENTS.md — committed project memory. */
  inProjectAgentsFile: string;
  /** <project>/.wrongstack/skills — committed project skills. */
  inProjectSkills: string;
  /** <project>/.wrongstack/design-kits — committed project Design Studio kits. */
  inProjectDesignKits: string;
  /** <project>/.wrongstack/worktrees — git worktrees for per-phase isolation (gitignored). */
  inProjectWorktrees: string;
  /** Stable hash for the project root. */
  projectHash: string;
  /** Human-readable project slug: `wrongstack-a1b2c3` instead of `3024e5e6fa58`. */
  projectSlug: string;
  /** ~/.wrongstack/projects/<hash>/goal.json — goal persistence */
  projectGoal: string;
  /** ~/.wrongstack/projects/<hash>/specs — SDD spec files */
  projectSpecs: string;
  /** ~/.wrongstack/projects/<hash>/task-graphs — SDD task graphs */
  projectTaskGraphs: string;
  /** ~/.wrongstack/projects/<hash>/sdd-session.json — SDD session state */
  projectSddSession: string;
  /** ~/.wrongstack/projects/<hash>/plan.json — plan persistence */
  projectPlan: string;
  /** ~/.wrongstack/projects/<hash>/autophase — AutoPhase phase-graph JSON files */
  projectAutophase: string;
  /** ~/.wrongstack/projects/<hash>/sdd-boards — live SDD board snapshots + JSONL event logs */
  projectSddBoards: string;
  /** ~/.wrongstack/sync.json — CloudSync configuration */
  syncConfig: string;
  /** Function to get the status.json path for a project given its hash. */
  projectStatus: (projectHash: string) => string;
}

export function projectHash(absRoot: string): string {
  return createHash('sha256').update(path.resolve(absRoot)).digest('hex').slice(0, 12);
}

/**
 * Human-readable project directory name: slugified folder name + short hash
 * suffix for uniqueness.  e.g. `wrongstack-a1b2c3` instead of `3024e5e6fa58`.
 */
export function projectSlug(absRoot: string): string {
  const base = slugify(path.basename(absRoot));
  const hash = createHash('sha256').update(path.resolve(absRoot)).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/** Turn a folder name into a filesystem-safe lowercase slug. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      // Collapse any run of non-alphanumeric chars into a single hyphen.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

export interface WstackPathOptions {
  userHome?: string | undefined;
  projectRoot: string;
  /** Override the global root (e.g. for tests). Default: `${userHome}/.wrongstack`. */
  globalRoot?: string | undefined;
}

/**
 * The global `~/.wrongstack` root, honoring the `WRONGSTACK_HOME` env
 * override. The override exists so tests (and sandboxed runs) can redirect
 * ALL global state — config, secrets, logs, projects/, mailboxes — away from
 * the real user home. Before it existed, `pnpm test` booted runtimes against
 * the real `~/.wrongstack`: it read the user's real config.json (starting a
 * second live Telegram poller), appended to the real wrongstack.log, and left
 * ~20k orphaned fixture dirs under projects/.
 *
 * Every code path that wants the global dir must come through here (or
 * through `resolveWstackPaths`) instead of `path.join(os.homedir(), '.wrongstack')`.
 */
export function wstackGlobalRoot(): string {
  const fromEnv = process.env['WRONGSTACK_HOME'];
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.wrongstack');
}

export function resolveWstackPaths(opts: WstackPathOptions): WstackPaths {
  // Precedence: explicit globalRoot > explicit userHome (callers/tests that
  // pass one expect paths under it) > WRONGSTACK_HOME env > real home dir.
  const globalRoot =
    opts.globalRoot ?? (opts.userHome ? path.join(opts.userHome, '.wrongstack') : wstackGlobalRoot());
  const hash = projectHash(opts.projectRoot);
  const slug = projectSlug(opts.projectRoot);
  const projectDir = path.join(globalRoot, 'projects', slug);
  return {
    globalRoot,
    configDir: globalRoot,
    globalConfig: path.join(globalRoot, 'config.json'),
    secretsKey: path.join(globalRoot, '.key'),
    globalMemory: path.join(globalRoot, 'memory.md'),
    globalSkills: path.join(globalRoot, 'skills'),
    globalDesignKits: path.join(globalRoot, 'design-kits'),
    globalPrompts: path.join(globalRoot, 'prompts'),
    cacheDir: path.join(globalRoot, 'cache'),
    modelsCache: path.join(globalRoot, 'cache', 'models.dev.json'),
    modelsOverlayCache: path.join(globalRoot, 'cache', 'models-overlay.json'),
    historyFile: path.join(globalRoot, 'history'),
    logFile: path.join(globalRoot, 'logs', 'wrongstack.log'),
    projectDir,
    projectCodebaseIndex: path.join(projectDir, 'codebase-index'),
    projectMemory: path.join(projectDir, 'memory.md'),
    projectSessions: path.join(projectDir, 'sessions'),
    projectTrust: path.join(projectDir, 'trust.json'),
    projectMeta: path.join(projectDir, 'meta.json'),
    projectLocalConfig: path.join(projectDir, 'config.local.json'),
    inProjectConfig: path.join(opts.projectRoot, '.wrongstack', 'config.json'),
    inProjectAgentsFile: path.join(opts.projectRoot, '.wrongstack', 'AGENTS.md'),
    inProjectSkills: path.join(opts.projectRoot, '.wrongstack', 'skills'),
    inProjectDesignKits: path.join(opts.projectRoot, '.wrongstack', 'design-kits'),
    inProjectWorktrees: path.join(opts.projectRoot, '.wrongstack', 'worktrees'),
    projectHash: hash,
    projectSlug: slug,
    projectGoal: path.join(projectDir, 'goal.json'),
    projectSpecs: path.join(projectDir, 'specs'),
    projectTaskGraphs: path.join(projectDir, 'task-graphs'),
    projectSddSession: path.join(projectDir, 'sdd-session.json'),
    projectPlan: path.join(projectDir, 'plan.json'),
    projectAutophase: path.join(projectDir, 'autophase'),
    projectSddBoards: path.join(projectDir, 'sdd-boards'),
    syncConfig: path.join(globalRoot, 'sync.json'),
    projectStatus: (projectHash: string) => path.join(globalRoot, 'projects', projectHash, 'status.json'),
  };
}
