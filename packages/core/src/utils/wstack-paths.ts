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
  /** ~/.wrongstack/cache — fetched data (models.dev, etc.). */
  cacheDir: string;
  /** ~/.wrongstack/cache/models.dev.json */
  modelsCache: string;
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
  /** <project>/.wrongstack/AGENTS.md — committed project memory. */
  inProjectAgentsFile: string;
  /** <project>/.wrongstack/skills — committed project skills. */
  inProjectSkills: string;
  /** Stable hash for the project root. */
  projectHash: string;
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
}

export function projectHash(absRoot: string): string {
  return createHash('sha256').update(path.resolve(absRoot)).digest('hex').slice(0, 12);
}

export interface WstackPathOptions {
  userHome?: string;
  projectRoot: string;
  /** Override the global root (e.g. for tests). Default: `${userHome}/.wrongstack`. */
  globalRoot?: string;
}

export function resolveWstackPaths(opts: WstackPathOptions): WstackPaths {
  const home = opts.userHome ?? os.homedir();
  const globalRoot = opts.globalRoot ?? path.join(home, '.wrongstack');
  const hash = projectHash(opts.projectRoot);
  const projectDir = path.join(globalRoot, 'projects', hash);
  return {
    globalRoot,
    configDir: globalRoot,
    globalConfig: path.join(globalRoot, 'config.json'),
    secretsKey: path.join(globalRoot, '.key'),
    globalMemory: path.join(globalRoot, 'memory.md'),
    globalSkills: path.join(globalRoot, 'skills'),
    cacheDir: path.join(globalRoot, 'cache'),
    modelsCache: path.join(globalRoot, 'cache', 'models.dev.json'),
    historyFile: path.join(globalRoot, 'history'),
    logFile: path.join(globalRoot, 'logs', 'wrongstack.log'),
    projectDir,
    projectMemory: path.join(projectDir, 'memory.md'),
    projectSessions: path.join(projectDir, 'sessions'),
    projectTrust: path.join(projectDir, 'trust.json'),
    projectMeta: path.join(projectDir, 'meta.json'),
    projectLocalConfig: path.join(projectDir, 'config.local.json'),
    inProjectAgentsFile: path.join(opts.projectRoot, '.wrongstack', 'AGENTS.md'),
    inProjectSkills: path.join(opts.projectRoot, '.wrongstack', 'skills'),
    projectHash: hash,
    projectGoal: path.join(projectDir, 'goal.json'),
    projectSpecs: path.join(projectDir, 'specs'),
    projectTaskGraphs: path.join(projectDir, 'task-graphs'),
    projectSddSession: path.join(projectDir, 'sdd-session.json'),
    projectPlan: path.join(projectDir, 'plan.json'),
    projectAutophase: path.join(projectDir, 'autophase'),
  };
}
