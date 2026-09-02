import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Path layout. All developer-level state lives in ~/.wrongstack/.
 * Per-project state is keyed by the canonical project root under
 * ~/.wrongstack/projects/<slug>/. Linked Git worktrees resolve to their main
 * checkout so coordination and durable state are shared across worktrees.
 *
 * The ONLY thing inside the project tree is the optional
 * .wrongstack/AGENTS.md (committed) and .wrongstack/skills/ (committed).
 */

export interface WstackPaths {
  /** ~/.wrongstack — global root. */
  globalRoot: string;
  /** Active profile name resolved from the bootstrap config. */
  profileName: string;
  /** ~/.wrongstack/profiles/<activeProfile> — active user-profile root. */
  profileDir: string;
  /** Absolute project root. */
  projectRoot: string;
  /** Home directory (~) — base for foreign tool state (~/.codex, ~/.agents, …). */
  homeDir: string;
  /**
   * ~/.wrongstack/profiles/<activeProfile> — directory for profile-scoped
   * user state (mode.json, statusline.json, custom-context-modes.json, …).
   */
  configDir: string;
  /** ~/.wrongstack/config.json — bootstrap config (activeProfile + version). */
  globalConfig: string;
  /**
   * ~/.wrongstack/profiles — directory containing per-profile configs.
   * Each profile has its own subdirectory with a config.json.
   */
  profilesDir: string;
  /**
   * Resolve the config path for a named profile.
   * Returns ~/.wrongstack/profiles/<name>/config.json.
   */
  profileConfig: (name: string) => string;
  /** Resolve ~/.wrongstack/profiles/<name>/statusline.json */
  profileStatuslineConfig: (name: string) => string;
  /** Resolve ~/.wrongstack/profiles/<name>/mode.json */
  profileModeConfig: (name: string) => string;
  /** Resolve ~/.wrongstack/profiles/<name>/provider-status.json */
  profileProviderStatus: (name: string) => string;
  /** Resolve ~/.wrongstack/profiles/<name>/provider-status-audit.jsonl */
  profileProviderAudit: (name: string) => string;
  /** Resolve ~/.wrongstack/profiles/<name>/update-cache.json */
  profileUpdateCache: (name: string) => string;
  /** ~/.wrongstack/.key — 32 random bytes, mode 0600, AES-GCM key for the secret vault. */
  secretsKey: string;
  /** ~/.wrongstack/profiles/<activeProfile>/memory.md — profile memory. */
  globalMemory: string;
  /** ~/.wrongstack/profiles/<activeProfile>/skills — profile skills. */
  globalSkills: string;
  /** ~/.claude/skills — user-global skills from foreign coding agents (Claude Code, Codex, …). Read-only. */
  globalClaudeSkills: string;
  /** ~/.wrongstack/profiles/<activeProfile>/design-kits — profile Design Studio kits. */
  globalDesignKits: string;
  /** ~/.wrongstack/profiles/<activeProfile>/prompts — profile prompt library. */
  globalPrompts: string;
  /** ~/.wrongstack/profiles/<activeProfile>/instructions — profile instruction overrides. */
  globalInstructions: string;
  /** ~/.wrongstack/profiles/<activeProfile>/prompt-usage.json — prompt usage. */
  promptUsage: string;
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
  /** ~/.wrongstack/profiles/<activeProfile>/history — REPL line history. */
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
  /** <project>/.claude/skills — project skills authored for foreign coding agents (Claude Code, …). Read-only. */
  inProjectClaudeSkills: string;
  /** <project>/.wrongstack/prompts — committed project prompt library. */
  inProjectPrompts: string;
  /** <project>/.wrongstack/instructions — committed project instruction overrides. */
  inProjectInstructions: string;
  /** <project>/.wrongstack/design-kits — committed project Design Studio kits. */
  inProjectDesignKits: string;
  /** <project>/.wrongstack/worktrees — git worktrees for per-phase isolation (gitignored). */
  inProjectWorktrees: string;
  /** Stable hash for the canonical project root (shared by linked Git worktrees). */
  projectHash: string;
  /** Human-readable canonical project slug, shared by linked Git worktrees. */
  projectSlug: string;
  /** ~/.wrongstack/projects/<hash>/goal.json — goal persistence */
  projectGoal: string;
  /** ~/.wrongstack/projects/<hash>/input-history.json — TUI prompt input history */
  projectInputHistory: string;
  /** ~/.wrongstack/projects/<hash>/specs — SDD spec files */
  projectSpecs: string;
  /** ~/.wrongstack/projects/<hash>/task-graphs — SDD task graphs */
  projectTaskGraphs: string;
  /** ~/.wrongstack/projects/<hash>/sdd-session.json — SDD session state */
  projectSddSession: string;
  /** ~/.wrongstack/projects/<hash>/plan.json — plan persistence */
  projectPlan: string;
  /** ~/.wrongstack/projects/<hash>/autophase — Goal phase-graph JSON files (dir name kept for backward compat) */
  projectAutophase: string;
  /** ~/.wrongstack/projects/<hash>/sdd-boards — live SDD board snapshots + JSONL event logs */
  projectSddBoards: string;
  /** ~/.wrongstack/projects/<hash>/requirement-intakes — requirement intake records */
  projectRequirementIntakes: string;
  /** ~/.wrongstack/profiles/<activeProfile>/sync.json — CloudSync configuration */
  syncConfig: string;
  /** ~/.wrongstack/config-history — timestamped backups on every config write */
  configHistoryDir: string;
  /** Function to get the status.json path for a validated project slug. */
  projectStatus: (projectSlug: string) => string;
}

/**
 * Resolve the stable project identity root used by global WrongStack state.
 *
 * A linked Git worktree has its own checkout path and a `.git` *file* that
 * points into `<main>/.git/worktrees/<name>`. Its `commondir` points back to
 * the main checkout's `.git` directory. Treating the linked checkout path as
 * the project identity would split one repository into multiple session,
 * registry, and mailbox directories — agents in different worktrees would be
 * unable to see or message each other.
 *
 * Project-local paths still use the caller's actual checkout. Only global
 * state identity is canonicalized. Non-Git projects, normal checkouts, Git
 * submodules, and separate-git-dir layouts keep their existing identity.
 */
export function canonicalProjectRoot(absRoot: string): string {
  const checkoutRoot = path.resolve(absRoot);
  const dotGit = path.join(checkoutRoot, '.git');

  try {
    if (!fs.statSync(dotGit).isFile()) return checkoutRoot;

    const gitDirLine = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(gitDirLine);
    if (!match?.[1]) return checkoutRoot;

    const gitDir = path.resolve(checkoutRoot, match[1].trim());
    const commonDirFile = path.join(gitDir, 'commondir');
    if (!fs.statSync(commonDirFile).isFile()) return checkoutRoot;

    const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
    // Only linked worktrees live immediately below `<common>/.git/worktrees`.
    // Submodules use `<common>/.git/modules/...` and retain their own identity.
    const worktreesDir = path.dirname(gitDir);
    if (path.basename(worktreesDir).toLowerCase() !== 'worktrees') return checkoutRoot;
    if (path.resolve(worktreesDir, '..') !== commonDir) return checkoutRoot;
    if (path.basename(commonDir).toLowerCase() !== '.git') return checkoutRoot;
    return path.dirname(commonDir);
  } catch {
    // Missing/malformed administrative files must never make path resolution
    // fail. Falling back preserves the pre-canonicalization behavior.
    return checkoutRoot;
  }
}

export function projectHash(absRoot: string): string {
  return createHash('sha256').update(canonicalProjectRoot(absRoot)).digest('hex').slice(0, 12);
}

/**
 * Human-readable project directory name: slugified folder name + short hash
 * suffix for uniqueness.  e.g. `wrongstack-a1b2c3` instead of `3024e5e6fa58`.
 */
export function projectSlug(absRoot: string): string {
  const identityRoot = canonicalProjectRoot(absRoot);
  const base = slugify(path.basename(identityRoot));
  const hash = createHash('sha256').update(identityRoot).digest('hex').slice(0, 6);
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
  /** Explicit profile override. Otherwise read from the root bootstrap config. */
  profileName?: string | undefined;
}

/** Make an untrusted profile name safe for use as one path segment. */
export function safeProfileName(name: string | undefined): string {
  const safe = (name ?? '')
    .replace(/[/\\:]/g, '_')
    .replace(/\.\./g, '_')
    .trim();
  return safe || 'default';
}

/**
 * Resolve the selected profile from ~/.wrongstack/config.json. The root file
 * is bootstrap metadata only; a missing/corrupt bootstrap selects `default`.
 *
 * Named for its SOURCE, not its meaning. This used to be `activeProfileName`,
 * the same name `cli/src/profile-config-path.ts` exports for a function that
 * reads the LIVE `Config` object instead of the bootstrap file on disk. Two
 * functions, one name, two sources that can disagree — the settings menu
 * writes `activeProfile` into the profile's own config, while `/profile use`
 * writes the bootstrap and demands a restart. A caller autocompleting the
 * wrong one gets a plausible answer about a different profile.
 */
export function bootstrapProfileName(globalRoot: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(globalRoot, 'config.json'), 'utf8')) as {
      activeProfile?: unknown;
    };
    return safeProfileName(
      typeof parsed.activeProfile === 'string' ? parsed.activeProfile : undefined,
    );
  } catch {
    return 'default';
  }
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
    opts.globalRoot ??
    (opts.userHome ? path.join(opts.userHome, '.wrongstack') : wstackGlobalRoot());
  // Home dir for FOREIGN tool state (Claude Code's ~/.claude). Independent of
  // WRONGSTACK_HOME, which redirects only WrongStack state: a real user's
  // Claude skills live in their real home, but tests pass `userHome` to keep
  // both `.wrongstack` and `.claude` under a temp dir.
  const homeDir = opts.userHome ?? os.homedir();
  const profileName = safeProfileName(opts.profileName ?? bootstrapProfileName(globalRoot));
  const profileDir = path.join(globalRoot, 'profiles', profileName);
  const hash = projectHash(opts.projectRoot);
  const slug = projectSlug(opts.projectRoot);
  const projectDir = path.join(globalRoot, 'projects', slug);
  return {
    globalRoot,
    profileName,
    profileDir,
    projectRoot: opts.projectRoot,
    homeDir,
    configDir: profileDir,
    globalConfig: path.join(globalRoot, 'config.json'),
    profilesDir: path.join(globalRoot, 'profiles'),
    profileConfig: (name: string) => {
      return path.join(globalRoot, 'profiles', safeProfileName(name), 'config.json');
    },
    profileStatuslineConfig: (name: string) => {
      return path.join(globalRoot, 'profiles', safeProfileName(name), 'statusline.json');
    },
    profileModeConfig: (name: string) => {
      return path.join(globalRoot, 'profiles', safeProfileName(name), 'mode.json');
    },
    profileProviderStatus: (name: string) => {
      return path.join(globalRoot, 'profiles', safeProfileName(name), 'provider-status.json');
    },
    profileProviderAudit: (name: string) => {
      return path.join(
        globalRoot,
        'profiles',
        safeProfileName(name),
        'provider-status-audit.jsonl',
      );
    },
    profileUpdateCache: (name: string) => {
      return path.join(globalRoot, 'profiles', safeProfileName(name), 'update-cache.json');
    },
    secretsKey: path.join(globalRoot, '.key'),
    globalMemory: path.join(profileDir, 'memory.md'),
    globalSkills: path.join(profileDir, 'skills'),
    globalClaudeSkills: path.join(homeDir, '.claude', 'skills'),
    globalDesignKits: path.join(profileDir, 'design-kits'),
    globalPrompts: path.join(profileDir, 'prompts'),
    globalInstructions: path.join(profileDir, 'instructions'),
    promptUsage: path.join(profileDir, 'prompt-usage.json'),
    cacheDir: path.join(globalRoot, 'cache'),
    modelsCache: path.join(globalRoot, 'cache', 'models.dev.json'),
    modelsOverlayCache: path.join(globalRoot, 'cache', 'models-overlay.json'),
    historyFile: path.join(profileDir, 'history'),
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
    inProjectClaudeSkills: path.join(opts.projectRoot, '.claude', 'skills'),
    inProjectPrompts: path.join(opts.projectRoot, '.wrongstack', 'prompts'),
    inProjectInstructions: path.join(opts.projectRoot, '.wrongstack', 'instructions'),
    inProjectDesignKits: path.join(opts.projectRoot, '.wrongstack', 'design-kits'),
    inProjectWorktrees: path.join(opts.projectRoot, '.wrongstack', 'worktrees'),
    projectHash: hash,
    projectSlug: slug,
    projectGoal: path.join(projectDir, 'goal.json'),
    projectInputHistory: path.join(projectDir, 'input-history.json'),
    projectSpecs: path.join(projectDir, 'specs'),
    projectTaskGraphs: path.join(projectDir, 'task-graphs'),
    projectSddSession: path.join(projectDir, 'sdd-session.json'),
    projectPlan: path.join(projectDir, 'plan.json'),
    projectAutophase: path.join(projectDir, 'autophase'),
    projectSddBoards: path.join(projectDir, 'sdd-boards'),
    projectRequirementIntakes: path.join(projectDir, 'requirement-intakes'),
    syncConfig: path.join(profileDir, 'sync.json'),
    configHistoryDir: path.join(globalRoot, 'config-history'),
    projectStatus: (statusProjectSlug: string) => {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,39})-[a-f0-9]{6}$/.test(statusProjectSlug)) {
        throw new Error(`Invalid project slug: ${statusProjectSlug}`);
      }
      return path.join(globalRoot, 'projects', statusProjectSlug, 'status.json');
    },
  };
}
