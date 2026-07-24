import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, color } from '@wrongstack/core/utils';
import { ConfigError, ERROR_CODES, FsError, type SecretVault } from '@wrongstack/core/types';
import type { ConfigStore } from '@wrongstack/core/types';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { formatDelay } from './utils/delay-format.js';

export interface SettingsMenuDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  configStore: ConfigStore;
  profileConfigPath: string;
  vault: SecretVault;
}

/**
 * Interactive settings manager. Shows current configuration values,
 * lets the user edit them, and persists changes back to the config file.
 * Loops until the user exits.
 */
export async function runSettingsMenu(deps: SettingsMenuDeps): Promise<number> {
  for (;;) {
    const config = deps.configStore.get();
    renderSettingsTopMenu(deps.renderer, config);

    const choice = (await deps.reader.readLine(`\n${color.amber('?')} Pick setting to edit: `))
      .trim()
      .toLowerCase();

    if (!choice || choice === 'q' || choice === 'quit' || choice === 'exit') {
      deps.renderer.write(color.dim('Done.\n'));
      return 0;
    }

    switch (choice) {
      case '1':
        await editAutoProceedDelay(deps);
        break;
      case '2':
        await editDefaultAutonomy(deps);
        break;
      case '3':
        await editAutonomyNextPrompt(deps);
        break;
      case 'd':
        await showDefaults(deps);
        break;
      default:
        deps.renderer.writeError(`Unknown selection: "${choice}". Try 1, 2, 3, or q to quit.`);
    }
  }
}

function renderSettingsTopMenu(
  renderer: TerminalRenderer,
  config: {
    autonomy?:
      | {
          autoProceedDelayMs?: number | undefined;
          defaultMode?: string | undefined;
          autonomyNextPrompt?: string | undefined;
        }
      | undefined;
  },
): void {
  const delay = config.autonomy?.autoProceedDelayMs ?? 45_000;
  const defMode = config.autonomy?.defaultMode ?? 'off';
  const nextPrompt = config.autonomy?.autonomyNextPrompt ?? 'auto {{suggestion}}';
  renderer.write(`\n${color.bold('WrongStack')} ${color.dim('— Settings')}\n\n`);
  renderer.write(
    `  ${color.bold('1.')} auto-proceed delay:    ${color.cyan(formatDelay(delay))} (in auto mode, wait before continuing)\n`,
  );
  renderer.write(`  ${color.bold('2.')} default autonomy mode: ${color.cyan(defMode)}\n`);
  renderer.write(`  ${color.bold('3.')} autonomy next prompt: ${color.cyan(nextPrompt)}\n`);
  renderer.write(`\n  ${color.dim('Actions:')}\n`);
  renderer.write(`    ${color.bold('1')}       Edit auto-proceed delay\n`);
  renderer.write(`    ${color.bold('2')}       Edit default autonomy mode\n`);
  renderer.write(`    ${color.bold('3')}       Edit autonomy next prompt\n`);
  renderer.write(`    ${color.bold('d')}       Show all defaults\n`);
  renderer.write(`    ${color.bold('q')}       Quit\n`);
}

async function editAutoProceedDelay(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(
    `\n${color.bold('Auto-proceed delay')} ${color.dim('— wait time before auto-continuing in auto mode')}\n`,
  );
  deps.renderer.write(
    color.dim(
      `  Current: ${formatDelay(deps.configStore.get().autonomy?.autoProceedDelayMs ?? 45_000)}\n`,
    ),
  );
  deps.renderer.write(
    color.dim(`  Enter value in SECONDS (e.g. 30 for 30 seconds, 0 to disable)\n`),
  );

  const raw = (await deps.reader.readLine(`  ${color.amber('?')} Delay (seconds): `)).trim();
  if (!raw || raw === 'q') return;

  const seconds = Number.parseFloat(raw);
  if (Number.isNaN(seconds) || seconds < 0) {
    deps.renderer.writeError(`Invalid number: "${raw}"`);
    return;
  }

  const ms = Math.round(seconds * 1000);
  await mutateAutonomyConfig(deps, (autonomy) => {
    autonomy.autoProceedDelayMs = ms;
  });
  deps.renderer.write(`  ${color.green('✓')} auto-proceed delay → ${formatDelay(ms)}\n`);
}

async function editDefaultAutonomy(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(`\n${color.bold('Default Autonomy Mode')}\n\n`);
  deps.renderer.write(`  ${color.bold('1.')} off     — agent stops after each turn (normal)\n`);
  deps.renderer.write(`  ${color.bold('2.')} suggest — shows next-step suggestions\n`);
  deps.renderer.write(
    `  ${color.bold('3.')} auto    — self-driving, agent continues automatically\n`,
  );
  deps.renderer.write(`  ${color.bold('q')}  Quit without changing\n`);

  const raw = (await deps.reader.readLine(`  ${color.amber('?')} Default mode: `))
    .trim()
    .toLowerCase();
  if (!raw || raw === 'q') return;

  const modes = ['off', 'suggest', 'auto'];
  let selected: string | null = null;
  if (raw === '1') selected = 'off';
  else if (raw === '2') selected = 'suggest';
  else if (raw === '3') selected = 'auto';
  else if (modes.includes(raw)) selected = raw;

  if (!selected) {
    deps.renderer.writeError(`Invalid mode: "${raw}". Use off, suggest, or auto.`);
    return;
  }

  await mutateAutonomyConfig(deps, (autonomy) => {
    autonomy.defaultMode = selected as 'off' | 'suggest' | 'auto';
  });
  deps.renderer.write(`  ${color.green('✓')} default autonomy → ${color.bold(selected)}\n`);
}

async function editAutonomyNextPrompt(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(
    `\n${color.bold('Autonomy next prompt')} ${color.dim('— template for auto-submitting next steps in YOLO+auto mode')}\n`,
  );
  const autonomy = deps.configStore.get().autonomy as Record<string, unknown> | undefined;
  const current = (autonomy?.autonomyNextPrompt as string | undefined) ?? 'auto {{suggestion}}';
  deps.renderer.write(color.dim(`  Current: ${current}\n`));
  deps.renderer.write(
    color.dim(`  Template uses {{suggestion}} placeholder for the next step text.\n`),
  );
  deps.renderer.write(color.dim(`  Examples:\n`));
  deps.renderer.write(color.dim(`    auto {{suggestion}}         (default - prepends "auto")\n`));
  deps.renderer.write(color.dim(`    proceed with: {{suggestion}}  (prepends "proceed with:")\n`));

  const raw = (await deps.reader.readLine(`  ${color.amber('?')} Prompt template: `)).trim();
  if (!raw || raw === 'q') return;

  if (!raw.includes('{{suggestion}}')) {
    deps.renderer.writeError(`Template must include {{suggestion}} placeholder.`);
    return;
  }

  await mutateAutonomyConfig(deps, (autonomy) => {
    (autonomy as Record<string, unknown>)['autonomyNextPrompt'] = raw;
  });
  deps.renderer.write(`  ${color.green('✓')} autonomy next prompt → ${color.bold(raw)}\n`);
}

async function showDefaults(deps: SettingsMenuDeps): Promise<void> {
  deps.renderer.write(`\n${color.bold('Default Values')}\n\n`);
  deps.renderer.write(
    `  auto-proceed delay:    ${color.cyan('45s')} (WRONGSTACK_AUTO_PROCEED_DELAY_MS env)\n`,
  );
  deps.renderer.write(`  default autonomy mode:  ${color.cyan('off')}\n`);
  deps.renderer.write(`  iteration timeout:      ${color.cyan('5 min')}\n`);
  deps.renderer.write(`  session timeout:        ${color.cyan('30 min')}\n`);
  deps.renderer.write(`  max iterations:         ${color.cyan('100')}\n`);
  deps.renderer.write(`\n${color.dim('  Press Enter to continue...')}`);
  await deps.reader.readLine('');
}

/** The subset of {@link SettingsMenuDeps} needed to persist a setting —
 *  no renderer/reader, so this is safe to call from non-interactive surfaces
 *  (the TUI, headless runs, the arg-driven `/settings` slash command). */
export interface PersistSettingDeps {
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

  // When writing to the project-local config, strip credentials so
  // apiKey / providers / sync never leak into a per-project file.
  const toWrite =
    isProfileOrGlobalTarget(actualTarget, deps) ? decrypted : filterSafeForProject(decrypted);

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

  // When writing to the project-local config, strip credentials so
  // apiKey / providers / sync never leak into a per-project file.
  const toWrite =
    isProfileOrGlobalTarget(actualTarget, deps) ? decrypted : filterSafeForProject(decrypted);

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

  // Also update the in-memory config store so changes are immediately visible
  deps.configStore.update({
    extensions: extensions as NonNullable<
      Parameters<typeof deps.configStore.update>[0]['extensions']
    >,
  });
}

/** Interactive-menu adapter over {@link persistAutonomySetting}. */
function mutateAutonomyConfig(
  deps: SettingsMenuDeps,
  mutator: (autonomy: {
    autoProceedDelayMs?: number | undefined;
    defaultMode?: string | undefined;
    enhance?: boolean | undefined;
    enhanceDelayMs?: number | undefined;
    enhanceLanguage?: string | undefined;
    autonomyNextPrompt?: string | undefined;
  }) => void,
): Promise<void> {
  return persistAutonomySetting(deps, mutator);
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
