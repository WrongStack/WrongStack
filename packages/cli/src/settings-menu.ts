import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import type { ConfigStore } from '@wrongstack/core/types';
import { ConfigError, ERROR_CODES, FsError, type SecretVault } from '@wrongstack/core/types';
import { atomicWrite, deepMerge } from '@wrongstack/core/utils';

/** Configuration and storage dependencies needed to persist a setting.
 *  This is safe to call from non-interactive surfaces such as the TUI,
 *  headless runs, and the arg-driven `/settings` slash command. */
interface PersistSettingDeps {
  configStore: ConfigStore;
  /** Path to the active profile config (~/.wrongstack/profiles/<name>/config.json). */
  profileConfigPath: string;
  /** Per-project config path (<project>/.wrongstack/config.json).
   *  Used when configScope === 'project'. Lives inside the project
   *  root so it can be gitignored or team-shared. */
  inProjectConfigPath?: string | undefined;
  vault: SecretVault;
  /** Force writes to the active profile config even when configScope is project. */
  forceGlobal?: boolean | undefined;
  /**
   * Optional resolver that recomputes the profile config path for a given
   * profile name. When set, {@link resolveActualTarget} uses this to
   * re-resolve the target path when `decrypted.activeProfile` differs from
   * the one used to compute `profileConfigPath`. This prevents the write
   * from landing in the wrong profile when the mutator changes activeProfile.
   */
  resolveProfilePath?: ((profileName: string) => string) | undefined;
}

export function resolvePersistPath(deps: PersistSettingDeps): string {
  if (deps.forceGlobal) return deps.profileConfigPath;
  const scope = (deps.configStore.get() as { configScope?: string | undefined }).configScope;
  if (scope === 'project' && deps.inProjectConfigPath) {
    return deps.inProjectConfigPath;
  }
  // Default user scope always means the active profile, never the root bootstrap.
  return deps.profileConfigPath;
}

/**
 * Re-resolve the target path after a mutator may have changed configScope.
 * Handles the two settings targets: project config or active profile config.
 */
export function resolveActualTarget(
  deps: PersistSettingDeps,
  decrypted: Record<string, unknown>,
  fallbackPath: string,
): string {
  if (deps.forceGlobal) return deps.profileConfigPath;
  const newScope = decrypted.configScope as string | undefined;
  // Recompute profile path when activeProfile changed in the mutation block.
  const newProfileName = decrypted.activeProfile as string | undefined;
  const effectiveProfilePath =
    newProfileName && deps.resolveProfilePath
      ? deps.resolveProfilePath(newProfileName)
      : deps.profileConfigPath;
  if (newScope === 'project' && deps.inProjectConfigPath) {
    return deps.inProjectConfigPath;
  }
  if (newScope === 'global') {
    return effectiveProfilePath;
  }
  return fallbackPath;
}

/**
 * Returns true when the target path is the trusted active-profile config, so
 * secrets are NOT stripped before writing.
 * Returns false for project-scoped paths where credentials must be filtered.
 */
function isProfileOrGlobalTarget(actualTarget: string, deps: PersistSettingDeps): boolean {
  return actualTarget === deps.profileConfigPath;
}

async function ensureProjectDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Directory already exists or is inaccessible — the write will surface the real error.
  }
}

/**
 * When configScope changed mid-save, the write target differs from the file
 * that was read.  Read the *destination* file, decrypt it, and deep-merge the
 * mutated `source` on top (prefer-patch so the user's explicit changes win).
 * This prevents a sparse source (e.g. project config without credentials)
 * from clobbering credential-bearing fields in the destination (e.g. profile
 * config with apiKey / providers / mcpServers).
 *
 * Returns `source` unchanged when destination does not exist yet.
 */
async function mergeWithDestinationIfExists(
  destPath: string,
  source: Record<string, unknown>,
  vault: SecretVault,
): Promise<Record<string, unknown>> {
  let destRaw: string;
  try {
    destRaw = await fs.readFile(destPath, 'utf8');
  } catch (err) {
    // Only swallow ENOENT (destination doesn't exist yet).
    // All other errors (EACCES, EIO, etc.) propagate as-is.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return source;
    }
    throw err;
  }
  let destParsed: Record<string, unknown>;
  try {
    destParsed = JSON.parse(destRaw) as Record<string, unknown>;
  } catch (err) {
    // Corrupt destination — don't merge, just write our content.
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        event: 'settings_menu_merge_skipped',
        message: `Skipping merge into corrupt destination file: ${destPath}`,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
    void err;
    return source;
  }
  const destDecrypted = decryptConfigSecrets(destParsed, vault) as Record<string, unknown>;
  return deepMerge(destDecrypted, source) as Record<string, unknown>;
}

/**
 * Fields that are safe to persist in a per-project `.wrongstack/config.json`.
 * Credential-bearing fields (apiKey, providers, sync) MUST NOT appear here —
 * they stay in the active profile config only. The active profile always gets the
 * full unfiltered object.
 *
 * When adding a field here, ask: "Would I commit this to a shared repo?"
 * If the answer is no, it doesn't belong on this list.
 */
const PROJECT_SAFE_FIELDS = new Set([
  'provider',
  'model',
  'fallbackModels',
  'fallbackBridge',
  // Kept in sync with core's IN_PROJECT_ALLOWED_KEYS (config-loader.ts): these
  // model-routing prefs are explicitly safe to READ from a per-project config,
  // so the writer must not strip them — otherwise a scope=project /fallback
  // profile/fav write (or a TUI full-config write under project scope) would be
  // silently dropped while the loader would happily accept them on next boot.
  'fallbackProfiles',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelAvailabilitySchedule',
  'fallbackAuto',
  'models',
  'modelMatrix',
  'maxConcurrent',
  'autonomy',
  'hints',
  'nextPrediction',
  'debugStream',
  'configScope',
  'yolo',
  'features',
  'context',
  'log',
  'session',
  'indexing',
  'tools',
  'launch',
  'circuitBreaker',
  'adaptiveConcurrency',
  'modelRuntime',
  'Sage',
]);

/**
 * Strip credential-bearing and machine-specific fields from a config object
 * so it is safe to write into a per-project `.wrongstack/config.json` file.
 * Returns a new object — the original is not mutated.
 */
export function filterSafeForProject(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (PROJECT_SAFE_FIELDS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Read the config file, apply `mutator` to its `autonomy` block, and write it
 * back atomically (then mirror into the in-memory config store). Pure I/O — no
 * terminal interaction — so it works identically under the plain REPL and the
 * Ink TUI.
 */
export async function persistAutonomySetting(
  deps: PersistSettingDeps,
  mutator: (autonomy: {
    autoProceedDelayMs?: number | undefined;
    defaultMode?: string | undefined;
    enhance?: boolean | undefined;
    enhanceDelayMs?: number | undefined;
    enhanceLanguage?: string | undefined;
  }) => void,
): Promise<void> {
  const targetPath = resolvePersistPath(deps);
  await ensureProjectDir(targetPath);

  let raw: string;
  let fileExists = true;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FsError({
        message: `Could not read ${targetPath}`,
        code: ERROR_CODES.FS_READ_FAILED,
        path: targetPath,
        cause: err,
      });
    }
    fileExists = false;
    raw = '{}';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new ConfigError({
        message: `Config at ${targetPath} is not valid JSON`,
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { path: targetPath },
        cause: err,
      });
    }
    parsed = {};
  }

  const decrypted = decryptConfigSecrets(parsed, deps.vault) as Record<string, unknown>;
  const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
  mutator(
    autonomy as { autoProceedDelayMs?: number | undefined; defaultMode?: string | undefined },
  );
  decrypted.autonomy = autonomy;

  // Re-resolve path — the mutator might have changed configScope.
  const actualTarget = resolveActualTarget(deps, decrypted as Record<string, unknown>, targetPath);
  if (actualTarget !== targetPath) {
    await ensureProjectDir(actualTarget);
  }

  // When configScope changed mid-save, merge into the destination file's
  // existing content so credential-bearing fields are preserved.
  const effectiveConfig =
    actualTarget !== targetPath
      ? await mergeWithDestinationIfExists(actualTarget, decrypted, deps.vault)
      : decrypted;

  // When writing to the project-local config, strip credentials so
  // apiKey / providers / sync never leak into a per-project file.
  const toWrite = isProfileOrGlobalTarget(actualTarget, deps)
    ? effectiveConfig
    : filterSafeForProject(effectiveConfig);

  const encrypted = encryptConfigSecrets(toWrite, deps.vault);
  await atomicWrite(actualTarget, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

  // Also update the in-memory config store so changes are immediately visible
  deps.configStore.update({
    autonomy: decrypted.autonomy as Parameters<typeof deps.configStore.update>[0]['autonomy'],
  });
}

/**
 * Read the config file, apply `mutator` to the full decrypted object, and
 * write it back atomically. This is used for small top-level settings that do
 * not warrant a dedicated helper.
 */
export async function persistConfigSetting(
  deps: PersistSettingDeps,
  mutator: (config: Record<string, unknown>) => void,
): Promise<void> {
  const targetPath = resolvePersistPath(deps);
  await ensureProjectDir(targetPath);

  let raw: string;
  let fileExists = true;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FsError({
        message: `Could not read ${targetPath}`,
        code: ERROR_CODES.FS_READ_FAILED,
        path: targetPath,
        cause: err,
      });
    }
    fileExists = false;
    raw = '{}';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new ConfigError({
        message: `Config at ${targetPath} is not valid JSON`,
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { path: targetPath },
        cause: err,
      });
    }
    parsed = {};
  }

  const decrypted = decryptConfigSecrets(parsed, deps.vault) as Record<string, unknown>;
  mutator(decrypted);

  // If the mutator changed configScope, re-resolve the target path.
  // Without this, a scope change from 'project' → 'global' would write
  // to the old project path instead of the new global one.
  const actualTarget = resolveActualTarget(deps, decrypted, targetPath);

  // Ensure the directory exists if we're writing to a new path
  if (actualTarget !== targetPath) {
    await ensureProjectDir(actualTarget);
  }

  // When configScope changed mid-save, merge into the destination file's
  // existing content so credential-bearing fields are preserved.
  const effectiveConfig =
    actualTarget !== targetPath
      ? await mergeWithDestinationIfExists(actualTarget, decrypted, deps.vault)
      : decrypted;

  // When writing to the project-local config, strip credentials so
  // apiKey / providers / sync never leak into a per-project file.
  const toWrite = isProfileOrGlobalTarget(actualTarget, deps)
    ? effectiveConfig
    : filterSafeForProject(effectiveConfig);

  const encrypted = encryptConfigSecrets(toWrite, deps.vault);
  await atomicWrite(actualTarget, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  deps.configStore.update(decrypted as Parameters<typeof deps.configStore.update>[0]);
}

/**
 * Persist Telegram plugin config to `extensions.telegram` in the active profile config
 * file. Mirrors `persistAutonomySetting` — reads the config, applies the
 * mutator, encrypts secrets, writes atomically, then updates ConfigStore.
 */
export async function persistTelegramConfig(
  deps: PersistSettingDeps,
  mutator: (telegram: Record<string, unknown>) => void,
): Promise<void> {
  const targetPath = deps.profileConfigPath;
  let raw: string;
  let fileExists = true;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FsError({
        message: `Could not read ${targetPath}: ${(err as Error).message}`,
        code: 'FS_READ_FAILED',
        path: targetPath,
        context: { operation: 'readGlobalConfig', phase: 'read' },
        cause: err,
      });
    }
    fileExists = false;
    raw = '{}';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new ConfigError({
        message: `Config at ${targetPath} is not valid JSON: ${(err as Error).message}`,
        code: 'CONFIG_PARSE_FAILED',
        context: { filePath: targetPath, operation: 'readProfileConfig' },
        cause: err,
      });
    }
    parsed = {};
  }

  const decrypted = decryptConfigSecrets(parsed, deps.vault) as Record<string, unknown>;
  const extensions = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
  const telegram = extensions.telegram ?? {};
  mutator(telegram);
  extensions.telegram = telegram;
  decrypted.extensions = extensions;

  const encrypted = encryptConfigSecrets(decrypted, deps.vault);
  await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  // Encrypting a new secret can create the vault key and schedule Windows ACL
  // hardening. Do not let a short-lived setup command return while that work
  // (and any warning it emits) is still detached from the command lifecycle.
  await deps.vault.flushHardening?.();

  // Also update the in-memory config store so changes are immediately visible
  deps.configStore.update({
    extensions: extensions as NonNullable<
      Parameters<typeof deps.configStore.update>[0]['extensions']
    >,
  });
}

/**
 * Derive the filesystem-access pair (`features.allowOutsideProjectRoot` and
 * `tools.restrictToProjectRoot`) from a save input. The two are inverses
 * of each other and the codebase intentionally keeps both in sync for
 * backward compatibility with older readers that only know about
 * `tools.restrictToProjectRoot`.
 *
 * Single source of truth: `allowOutsideProjectRoot`. If the caller only
 * sets `restrictFsToRoot`, it is converted to its inverse. If both are
 * set (which the picker should not do, but defensive code paths may),
 * `allowOutsideProjectRoot` wins. Returns `undefined` if neither is set,
 * so the caller can skip the write.
 *
 * The input is duck-typed (only the two relevant fields are read) so any
 * caller can pass a partial shape: the TUI's full `LiveSettingsInput`,
 * a slash-command's `{ restrictFsToRoot: boolean }`, or any future
 * save-handler that only carries these two knobs.
 */
export function deriveFsAccessPair(input: {
  allowOutsideProjectRoot?: boolean | undefined;
  restrictFsToRoot?: boolean | undefined;
}): { allowOutsideProjectRoot: boolean; restrictToProjectRoot: boolean } | undefined {
  if (input.allowOutsideProjectRoot !== undefined) {
    const allow = input.allowOutsideProjectRoot;
    return { allowOutsideProjectRoot: allow, restrictToProjectRoot: !allow };
  }
  if (input.restrictFsToRoot !== undefined) {
    const restrict = input.restrictFsToRoot;
    return { allowOutsideProjectRoot: !restrict, restrictToProjectRoot: restrict };
  }
  return undefined;
}
