import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, TokenSavingTier } from '@wrongstack/contracts/types/config';
import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@wrongstack/contracts/types/provider';
import { migrateLegacyConfig, migrateProfileFiles } from './boot-config-migration.js';
import {
  assertProjectRootOutsideStateDir,
  cleanupStaleProjects,
  registerProjectInManifest,
  writeProjectMeta,
} from './boot-project-registration.js';
import { DefaultLogger, noOpLogger } from './infrastructure/logger.js';
import { DefaultPathResolver } from './infrastructure/path-resolver.js';
import { DefaultSecretVault, migratePlaintextSecrets } from './security/secret-vault.js';
import { ALL_DESTRUCTIVE_KINDS } from './security/yolo-risk.js';
import { DefaultConfigLoader } from './storage/config-loader.js';
import { toErrorMessage } from './utils/error.js';
import {
  ensureProjectGitignore,
  ensureProjectIdentity,
  readProjectIdentity,
} from './utils/project-identity.js';
import { activateProjectStateGuard } from './utils/project-state-guard.js';
import { writeErr } from './utils/term.js';
import {
  canonicalProjectRoot,
  resolveWstackPaths,
  type WstackPaths,
} from './utils/wstack-paths.js';

export {
  assertProjectRootOutsideStateDir,
  cleanupStaleProjects,
} from './boot-project-registration.js';

/**
 * Values `--token-saving-tier` accepts, including the `'auto'` default. Kept
 * as a literal set so the flag rejects a typo instead of silently resolving it.
 */
const TOKEN_SAVING_TIER_FLAG_VALUES: ReadonlySet<string> = new Set<TokenSavingTier>([
  'auto',
  'off',
  'minimal',
  'light',
  'medium',
  'aggressive',
]);

/**
 * Options for {@link bootConfig}. Both the CLI and the WebUI server boot the
 * same way; the only intentional differences are the label used in the
 * plaintext-secret migration notice and whether CLI flags are supplied.
 */
export interface BootConfigOptions {
  /**
   * Parsed CLI flags. `cwd` relocates path resolution; `provider`/`model`/
   * `log-level`/`verbose`/`trace`/`yolo` are patched into the
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
  // `--effort <level>` is the startup twin of `/effort <level>`: same config
  // key, but a session-only patch. An unknown level leaves the configured
  // effort alone rather than guessing, like `--token-saving-tier`.
  if (typeof flags['effort'] === 'string') {
    const requested = flags['effort'].trim().toLowerCase();
    if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(requested)) {
      patch.modelRuntime = {
        reasoning: { effort: requested as ReasoningEffort },
      } as Config['modelRuntime'];
    }
  }
  if (typeof flags['log-level'] === 'string') {
    patch.log = { level: flags['log-level'] as Config['log']['level'] };
  } else if (flags['verbose']) {
    patch.log = { level: 'debug' };
  } else if (flags['trace']) {
    patch.log = { level: 'trace' };
  }
  if (flags['no-yolo'] === true) patch.yolo = false;
  else if (flags['yolo']) patch.yolo = true;
  // `--yolo-plus`: YOLO with nothing held back — no prompt at all. `--no-yolo`
  // wins, and also clears a YOLO+ the config file turned on.
  if (flags['no-yolo'] === true) {
    patch.autonomy = { ...patch.autonomy, yoloPlus: false };
  } else if (flags['yolo-plus'] === true) {
    patch.yolo = true;
    patch.autonomy = { ...patch.autonomy, yoloPlus: true };
  }
  // `--yolo-destructive` was parsed and then dropped on the floor: nothing read
  // it, so the one documented way to widen YOLO did nothing. It now un-gates
  // every kind the user is allowed to un-gate — `resolveYoloConfirmKinds` still
  // re-adds `agent-state` and `credential-bind`, which no flag may switch off.
  if (flags['yolo-destructive'] === true) {
    patch.autonomy = {
      ...patch.autonomy,
      yoloConfirm: Object.fromEntries(ALL_DESTRUCTIVE_KINDS.map((kind) => [kind, false])),
    };
  }
  if (flags['token-saving-mode']) {
    patch.features ??= {} as Config['features'];
    patch.features.tokenSavingMode = true;
  }
  // `--system-<variant>` / `--system-prompt <variant>` pin the identity for this
  // launch only; `pro` wins when several variant flags are given.
  const promptVariant =
    (['pro', 'lite', 'scout'] as const).find(
      (variant) => isEnabledFlag(flags[`system-${variant}`]) || flags['system-prompt'] === variant,
    ) ?? (flags['system-prompt'] === 'default' ? 'default' : undefined);
  if (promptVariant) patch.systemPrompt = { variant: promptVariant };
  // `--token-saving-tier <level>` takes precedence over `--token-saving-mode`.
  // Supported values: auto, off, minimal, light, medium, aggressive.
  //
  // The value is passed through verbatim rather than normalized. Normalizing
  // collapsed `'auto'` — the shipped default — to `'medium'`, so asking for the
  // default on the command line silently pinned a concrete tier; and it mapped
  // any unrecognized value to `'off'`, so a typo in the one flag whose job is
  // shrinking the prompt handed you the full one instead. An unrecognized
  // value now leaves the configured tier alone.
  if (typeof flags['token-saving-tier'] === 'string') {
    const requested = flags['token-saving-tier'];
    if (TOKEN_SAVING_TIER_FLAG_VALUES.has(requested)) {
      patch.features ??= {} as Config['features'];
      patch.features.tokenSavingMode = requested as TokenSavingTier;
    }
  }
  return patch;
}
