import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultLogger, noOpLogger } from './infrastructure/logger.js';
import { DefaultPathResolver } from './infrastructure/path-resolver.js';
import type { EventBus } from './kernel/events.js';
import { DefaultSecretVault, migratePlaintextSecrets } from './security/secret-vault.js';
import { DefaultConfigLoader } from './storage/config-loader.js';
import { type Config, normalizeTokenSavingTier } from './types/config.js';
import { atomicWrite } from './utils/atomic-write.js';
import { toErrorMessage } from './utils/error.js';
import {
  ensureProjectGitignore,
  ensureProjectIdentity,
  readProjectIdentity,
} from './utils/project-identity.js';
import { activateProjectStateGuard } from './utils/project-state-guard.js';
import { safeParse } from './utils/safe-json.js';
import { writeErr } from './utils/term.js';
import {
  canonicalProjectRoot,
  resolveWstackPaths,
  safeProfileName,
  type WstackPaths,
} from './utils/wstack-paths.js';

/**
 * Options for {@link bootConfig}. Both the CLI and the WebUI server boot the
 * same way; the only intentional differences are the label used in the
 * plaintext-secret migration notice and whether CLI flags are supplied.
 */
export interface BootConfigOptions {
  /**
   * Parsed CLI flags. `cwd` relocates path resolution; `provider`/`model`/
   * `log-level`/`verbose`/`trace`/`yolo`/`no-features` are patched into the
   * loaded config (see {@link flagsToConfigPatch}). Defaults to `{}` (the
   * WebUI server passes no flags).
   */
  flags?: Record<string, string | boolean>;
  /**
   * Label shown in the `[<label>] Encrypted N plaintext secret(s) in FILE`
   * stderr notice emitted when legacy plaintext secrets get auto-encrypted.
   * The CLI passes `wstack`; the WebUI server passes `WebUI`. Default
   * `wstack`.
   */
  appLabel?: string | undefined;
  /**
   * Load the active profile's `sync.json` and merge it into `config.sync` so the
   * ConfigStore starts with the correct CloudSync state. Default `true`.
   */
  loadSyncConfig?: boolean | undefined;
  /**
   * Skip the provider/model identity validation during config load. When
   * `true`, a missing provider or model in config does NOT throw — the
   * boot caller is responsible for handling the missing-provider case
   * (e.g. showing a setup screen). Used by `--webui` mode so the WebUI
   * can boot without a configured provider and show the setup screen.
   */
  skipIdentityValidation?: boolean | undefined;
}

/**
 * Everything the boot phase resolves before DI-container wiring. Superset of
 * what the CLI and WebUI server each consumed previously, so both can pick the
 * fields they need from a single canonical result.
 */
export interface BootConfigResult {
  cwd: string;
  projectRoot: string;
  userHome: string;
  wpaths: WstackPaths;
  pathResolver: DefaultPathResolver;
  config: Config;
  vault: DefaultSecretVault;
  logger: DefaultLogger;
  /** Convenience alias for `wpaths.globalConfig`. */
  globalConfigPath: string;
}

/**
 * Canonical boot routine shared by `@wrongstack/cli` and `@wrongstack/webui`.
 * Resolves paths, creates the real AES-GCM secret vault, migrates any
 * plaintext secrets, loads + merges config (with CLI-flag overrides and an
 * optional sync overlay), and builds a logger.
 *
 * The per-package `bootConfig()` wrappers re-shape this result into their own
 * legacy return types for backward compatibility — keep this the single source
 * of boot behavior so the two consumers can't drift.
 */
export async function bootConfig(options: BootConfigOptions = {}): Promise<BootConfigResult> {
  const {
    flags = {},
    appLabel = 'wstack',
    loadSyncConfig = true,
    skipIdentityValidation = false,
  } = options;

  const cwd = typeof flags['cwd'] === 'string' ? path.resolve(flags['cwd']) : process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const projectIdentityRoot = canonicalProjectRoot(projectRoot);
  const userHome = os.homedir();
  // No explicit userHome here: that would defeat the WRONGSTACK_HOME env
  // override (tests / sandboxed runs redirect all global state through it).
  const wpaths = resolveWstackPaths({ projectRoot });

  // Refuse to treat WrongStack's own state directory as a project. Must run
  // BEFORE the mkdir/registerProjectInManifest block below, or the bogus
  // namespace gets materialized on disk before we can complain about it.
  assertProjectRootOutsideStateDir(projectRoot, wpaths.globalRoot);

  // The project-local state surface is a runtime invariant. Users and cleanup
  // tools can remove it while the app is open; keep it present so consumers
  // never fail with ENOENT between turns.
  await activateProjectStateGuard(projectRoot);

  // Ensure the directories every consumer relies on exist. This is the union
  // of what the cli and webui boot paths created independently — creating all
  // three eagerly is harmless and removes the "new wpath added to one copy
  // only" drift hazard.
  await fs.mkdir(wpaths.globalRoot, { recursive: true });
  await fs.mkdir(wpaths.profilesDir, { recursive: true });
  await fs.mkdir(wpaths.projectDir, { recursive: true });
  await fs.mkdir(wpaths.projectSessions, { recursive: true });
  let registeredProjectId: string | undefined;
  try {
    registeredProjectId = (await readProjectIdentity(projectRoot))?.projectId;
  } catch {
    // Malformed identity is reported by the HQ publisher; boot registration
    // still falls back to its historical path-scoped metadata.
  }
  await writeProjectMeta(wpaths, projectIdentityRoot, registeredProjectId);
  await registerProjectInManifest(
    wpaths,
    projectIdentityRoot,
    undefined,
    cwd !== projectIdentityRoot ? cwd : undefined,
    registeredProjectId,
  );
  await ensureProjectGitignore(projectRoot).catch(() => undefined);

  // ═════════════════════════════════════════════════════════════════════
  // Legacy config migration: move ~/.wrongstack/config.json content into
  // ~/.wrongstack/profiles/default/config.json BEFORE any config load.
  // Starting with 0.291.0 the root config is a thin bootstrap pointer
  // (version + activeProfile); all user settings live in the profile config.
  // ═════════════════════════════════════════════════════════════════════
  await migrateLegacyConfig(wpaths);

  // ═════════════════════════════════════════════════════════════════════
  // Profile-state migration: copy all legacy user-owned files/directories
  // from the global root into the active profile if missing there.
  // ═════════════════════════════════════════════════════════════════════
  await migrateProfileFiles(wpaths);

  // Clean up stale project directories left behind by tests or deleted
  // working directories.  Best-effort — never blocks boot.
  cleanupStaleProjects(wpaths).catch((err) => {
    noOpLogger.debug('cleanupStaleProjects failed', { err });
  });

  // Preliminary logger — created before config load so both the vault and
  // config loader have a structured Logger for their warnings. Uses the
  // env-level or 'info' (handled by DefaultLogger constructor); replaced
  // with the properly-configured logger once config is loaded.
  const bootLogger = new DefaultLogger({ stderr: true });

  // Vault must come first so the config loader can decrypt apiKey-like fields.
  // It lazily creates ~/.wrongstack/.key on first encrypt/decrypt.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey, logger: bootLogger });

  // Auto-encrypt any plaintext secrets still sitting in config files (left
  // over from before the vault existed, or hand-written). Silent no-op for
  // already-encrypted configs; never blocks boot on migration issues.
  // Uses noOpLogger because the structured logger isn't built until after
  // config loads; migration is best-effort and the warning it would emit
  // (permission errors on restrictFilePermissions) is the same one the
  // main logger would surface on the next boot.
  // Also migrate secrets in the selected profile config.
  // Defensive: profileConfig may not be available in test mocks.
  const bootstrapProfilePath =
    typeof wpaths.profileConfig === 'function' ? wpaths.profileConfig(wpaths.profileName) : null;
  const secretFiles = [wpaths.projectLocalConfig].filter(Boolean) as string[];
  if (bootstrapProfilePath) secretFiles.push(bootstrapProfilePath);
  for (const file of secretFiles) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault, noOpLogger);
      if (migrated > 0) {
        writeErr(`[${appLabel}] Encrypted ${migrated} plaintext secret(s) in ${file}\n`);
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault, logger: bootLogger });
  let config: Config;
  try {
    config = await configLoader.load({ cliFlags: flagsToConfigPatch(flags) });
  } catch (err) {
    if (
      skipIdentityValidation &&
      err instanceof Error &&
      err.message.includes('no provider configured')
    ) {
      // --webui mode: boot without a configured provider. Do not inject
      // a provider/model identity here; downstream setup state must stay
      // visibly unconfigured until the user picks a real target.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'boot.no_provider_configured',
          app: appLabel,
          message: 'No provider configured — setup screen will be shown',
          timestamp: new Date().toISOString(),
        }),
      );
      try {
        config = await configLoader.load({
          cliFlags: flagsToConfigPatch(flags),
          skipIdentityValidation: true,
        });
      } catch (fallbackErr) {
        // Best-effort: if even the skip-validation load fails (corrupt config,
        // FS error), create a minimal in-memory config so --webui can still show
        // the setup screen instead of crashing at boot.
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'boot.config_fallback',
            message: `Config load fallback triggered: ${toErrorMessage(fallbackErr)}`,
            timestamp: new Date().toISOString(),
          }),
        );
        config = Object.freeze({}) as Config;
      }
    } else {
      throw err;
    }
  }

  // Load and decrypt sync config from the active profile and merge it into
  // the main config so ConfigStore starts with the correct sync state.
  // `load()` returns a frozen Config, so rebuild a new frozen object rather
  // than mutating in place (a direct assignment throws "Cannot add property
  // sync, object is not extensible" once sync.json exists).
  if (loadSyncConfig) {
    const syncConfig = await configLoader.loadSyncConfig();
    if (syncConfig) {
      config = Object.freeze({ ...config, sync: syncConfig }) as Config;
    }
  }

  // A committed project identity lets independent clones and worktrees join
  // the same HQ project. Existing alias-based installations keep their legacy
  // identity until they explicitly initialize/rekey the repository.
  if (!config.hq?.projectAlias) {
    try {
      await ensureProjectIdentity(projectRoot);
    } catch (error) {
      bootLogger.warn?.('Could not initialize .wrongstack/project.json', {
        event: 'project.identity_init_failed',
        error: toErrorMessage(error),
      });
    }
  }

  let committedProjectId: string | undefined;
  try {
    committedProjectId = (await readProjectIdentity(projectRoot))?.projectId;
  } catch {
    // The HQ publisher reports malformed identity files when it tries to use
    // them. Local boot state remains available so the user can repair/rekey.
  }
  if (committedProjectId !== registeredProjectId) {
    await writeProjectMeta(wpaths, projectIdentityRoot, committedProjectId);
    await registerProjectInManifest(
      wpaths,
      projectIdentityRoot,
      undefined,
      cwd !== projectIdentityRoot ? cwd : undefined,
      committedProjectId,
    );
  }

  const logger = new DefaultLogger({ level: config.log?.level ?? 'info', file: wpaths.logFile });

  // Initialize the cross-process session registry so /sessions status works
  // and the agent status tracker can register entries later.
  try {
    const { getProjectSessionRegistry } = await import('./session-catalog/registry.js');
    getProjectSessionRegistry(wpaths.globalRoot);
  } catch {
    // Non-critical — session tracking degrades gracefully
  }

  return {
    cwd,
    projectRoot,
    userHome,
    wpaths,
    pathResolver,
    config,
    vault,
    logger,
    globalConfigPath: wpaths.globalConfig,
  };
}

function isEnabledFlag(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Translate parsed CLI flags into a partial Config patch applied on top of the
 * file-loaded config. Explicit `--log-level` wins over `--verbose`/`--trace`.
 */
export function flagsToConfigPatch(flags: Record<string, string | boolean>): Partial<Config> {
  const patch: Partial<Config> = {};
  if (typeof flags['provider'] === 'string') patch.provider = flags['provider'];
  if (typeof flags['model'] === 'string') patch.model = flags['model'];
  if (typeof flags['fallback-model'] === 'string') {
    const list = flags['fallback-model']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) patch.fallbackModels = list;
  }
  if (typeof flags['cwd'] === 'string') patch.cwd = flags['cwd'];
  if (typeof flags['log-level'] === 'string') {
    patch.log = { level: flags['log-level'] as Config['log']['level'] };
  } else if (flags['verbose']) {
    patch.log = { level: 'debug' };
  } else if (flags['trace']) {
    patch.log = { level: 'trace' };
  }
  if (flags['no-yolo'] === true) patch.yolo = false;
  else if (flags['yolo']) patch.yolo = true;
  if (flags['no-features']) {
    patch.features = {
      mcp: false,
      plugins: false,
      memory: false,
      modelsRegistry: false,
      skills: false,
    };
  }
  if (flags['token-saving-mode']) {
    patch.features ??= {} as Config['features'];
    patch.features.tokenSavingMode = true;
  }
  if (isEnabledFlag(flags['system-pro']) || flags['system-prompt'] === 'pro') {
    patch.systemPrompt = { variant: 'pro' };
  } else if (isEnabledFlag(flags['system-lite']) || flags['system-prompt'] === 'lite') {
    patch.systemPrompt = { variant: 'lite' };
  } else if (flags['system-prompt'] === 'default') {
    patch.systemPrompt = { variant: 'default' };
  }
  // `--token-saving-tier <level>` takes precedence over `--token-saving-mode`.
  // Supported values: off, minimal, light, medium, aggressive.
  if (typeof flags['token-saving-tier'] === 'string') {
    patch.features ??= {} as Config['features'];
    patch.features.tokenSavingMode = normalizeTokenSavingTier(
      flags['token-saving-tier'] as 'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
    );
  }
  return patch;
}

/**
 * Before 0.291.0, all config lived in ~/.wrongstack/config.json.
 * Starting with 0.291.0, the root config is a thin bootstrap (version +
 * activeProfile) and settings live in ~/.wrongstack/profiles/<name>/config.json.
 *
 * This function migrates a legacy flat config into the default profile config
 * BEFORE any config loader runs, so the loader always reads from the right place.
 *
 * Migration is allowed only when the selected profile file does not exist.
 * An existing empty or corrupt profile is still authoritative: root settings
 * must never be re-imported once profiles are in use.
 */
async function migrateLegacyConfig(wpaths: WstackPaths): Promise<void> {
  const rootFp = wpaths.globalConfig;

  // If legacy root doesn't exist, nothing to migrate.
  let legacyRaw: string;
  try {
    legacyRaw = await fs.readFile(rootFp, 'utf8');
  } catch {
    return; // ENOENT or other error — nothing to migrate
  }

  // Validate the legacy content is parseable JSON with actual settings.
  const result = safeParse<Record<string, unknown>>(legacyRaw);
  if (
    !result.ok ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  ) {
    return;
  }

  const activeProfile = safeProfileName(
    typeof result.value['activeProfile'] === 'string' ? result.value['activeProfile'] : undefined,
  );
  const profileFp = wpaths.profileConfig(activeProfile);

  // File existence, not content, is the boundary. Never recover settings from
  // root over an existing profile, even when that profile is empty or corrupt.
  try {
    await fs.access(profileFp);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }

  await fs.mkdir(path.dirname(profileFp), { recursive: true });

  // Copy legacy content into the profile config, stripping bootstrap-only fields.
  const profileContent = { ...result.value };
  delete profileContent['activeProfile'];

  await atomicWrite(profileFp, JSON.stringify(profileContent, null, 2), { mode: 0o600 });

  // Write the root config as a thin bootstrap pointer.
  const bootstrap = { version: 1, activeProfile };

  try {
    await atomicWrite(rootFp, JSON.stringify(bootstrap, null, 2), { mode: 0o600 });
  } catch {
    // best-effort — profile already migrated
  }
}

/** Pairs of (legacy root source, profile destination) that need migration. */
const PROFILE_STATE_PAIRS: ReadonlyArray<{
  globalSrc: (wpaths: WstackPaths) => string;
  profileDst: (wpaths: WstackPaths, name: string) => string;
}> = [
  {
    globalSrc: (w) => path.join(w.globalRoot, 'statusline.json'),
    profileDst: (w, n) => w.profileStatuslineConfig(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'mode.json'),
    profileDst: (w, n) => w.profileModeConfig(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'provider-status.json'),
    profileDst: (w, n) => w.profileProviderStatus(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'update-cache.json'),
    profileDst: (w, n) => w.profileUpdateCache(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'memory.md'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'memory.md'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'history'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'history'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'sync.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'sync.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'sync-state.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'sync-state.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'prompt-usage.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'prompt-usage.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'custom-context-modes.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'custom-context-modes.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'desktop.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'desktop.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'installed-skills.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'installed-skills.json'),
  },
  ...['skills', 'prompts', 'instructions', 'design-kits', 'desktop', 'settings'].map(
    (directory) => ({
      globalSrc: (w: WstackPaths) => path.join(w.globalRoot, directory),
      profileDst: (w: WstackPaths, n: string) => path.join(w.profilesDir, n, directory),
    }),
  ),
];

/**
 * Migrate legacy profile-owned files and directories from the global root
 * into the active profile's directory. Runs after migrateLegacyConfig() so the
 * active profile name is resolved from the now-migrated root bootstrap.
 *
 * For each entry: if it exists in the profile directory, it's left untouched
 * (idempotent). If it's missing in the profile but exists at the global root,
 * it's copied into the profile. If neither exists, silently skipped.
 * Best-effort: failures never block boot.
 */
async function migrateProfileFiles(wpaths: WstackPaths): Promise<void> {
  // Read the active profile name from the bootstrap (already migrated by
  // migrateLegacyConfig above). Default to 'default' if unset.
  let profileName = wpaths.profileName;
  try {
    const raw = await fs.readFile(wpaths.globalConfig, 'utf8');
    const parsed = safeParse<Record<string, unknown>>(raw);
    if (parsed.ok && parsed.value && typeof parsed.value.activeProfile === 'string') {
      profileName = safeProfileName(parsed.value.activeProfile);
    }
  } catch {
    // best-effort — default profile
  }

  // Ensure the profile directory exists so the copy targets are writable.
  try {
    await fs.mkdir(path.join(wpaths.profilesDir, profileName), { recursive: true });
  } catch {
    return;
  }

  for (const pair of PROFILE_STATE_PAIRS) {
    const src = pair.globalSrc(wpaths);
    const dst = pair.profileDst(wpaths, profileName);

    // Confirm the global source exists and capture its type.
    let srcIsDir: boolean;
    try {
      srcIsDir = (await fs.stat(src)).isDirectory();
    } catch {
      continue; // no global source — nothing to migrate
    }

    // Skip if the profile already has this entry with the matching type
    // (idempotent). A type mismatch indicates corrupt partial state left by
    // a botched earlier migration (e.g. a file where a directory belongs);
    // remove the wrong-typed stub so the copy below can recover the tree.
    try {
      const dstStat = await fs.stat(dst);
      if (dstStat.isDirectory() === srcIsDir) {
        continue; // already migrated with the correct type
      }
      await fs.rm(dst, { recursive: true, force: true });
    } catch (err) {
      // Only proceed to copy when dst genuinely doesn't exist (ENOENT).
      // Other errors (EACCES, EMFILE, …) mean we can't safely determine
      // dst state — skip this entry rather than risk a broken copy.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        writeErr(`migrateProfileFiles: skipping ${dst} (stat error: ${code ?? 'unknown'})\n`);
        continue;
      }
    }

    // Copy the global file/directory into the profile directory.
    try {
      if (srcIsDir) {
        await fs.cp(src, dst, { recursive: true, errorOnExist: false, force: false });
      } else {
        const content = await fs.readFile(src);
        await fs.writeFile(dst, content, { mode: 0o600 });
      }
    } catch {
      // best-effort — never block boot
    }
  }
}

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
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
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

async function writeProjectMeta(
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
async function registerProjectInManifest(
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
      JSON.parse(raw); // validate
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

  // Write updated manifest
  try {
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
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
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
      const nested = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
