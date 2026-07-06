import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from './kernel/events.js';
import { DefaultLogger, noOpLogger } from './infrastructure/logger.js';
import { DefaultPathResolver } from './infrastructure/path-resolver.js';
import { DefaultSecretVault, migratePlaintextSecrets } from './security/secret-vault.js';
import { DefaultConfigLoader } from './storage/config-loader.js';
import { type Config, normalizeTokenSavingTier } from './types/config.js';
import { writeErr } from './utils/term.js';
import { toErrorMessage } from './utils/error.js';
import { type WstackPaths, resolveWstackPaths } from './utils/wstack-paths.js';

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
   * Load `~/.wrongstack/sync.json` and merge it into `config.sync` so the
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
  const { flags = {}, appLabel = 'wstack', loadSyncConfig = true, skipIdentityValidation = false } = options;

  const cwd = typeof flags['cwd'] === 'string' ? path.resolve(flags['cwd']) : process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const userHome = os.homedir();
  // No explicit userHome here: that would defeat the WRONGSTACK_HOME env
  // override (tests / sandboxed runs redirect all global state through it).
  const wpaths = resolveWstackPaths({ projectRoot });

  // Ensure the directories every consumer relies on exist. This is the union
  // of what the cli and webui boot paths created independently — creating all
  // three eagerly is harmless and removes the "new wpath added to one copy
  // only" drift hazard.
  await fs.mkdir(wpaths.globalRoot, { recursive: true });
  await fs.mkdir(wpaths.projectDir, { recursive: true });
  await fs.mkdir(wpaths.projectSessions, { recursive: true });
  await writeProjectMeta(wpaths, projectRoot);
  // Also register/update the project in ~/.wrongstack/projects.json
  await registerProjectInManifest(wpaths, projectRoot);
  await ensureGitignore(projectRoot);

  // Clean up stale project directories left behind by tests or deleted
  // working directories.  Best-effort — never blocks boot.
  cleanupStaleProjects(wpaths).catch((err) => {
    noOpLogger.debug('cleanupStaleProjects failed', { err });
  });

  // Vault must come first so the config loader can decrypt apiKey-like fields.
  // It lazily creates ~/.wrongstack/.key on first encrypt/decrypt.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey });

  // Auto-encrypt any plaintext secrets still sitting in config files (left
  // over from before the vault existed, or hand-written). Silent no-op for
  // already-encrypted configs; never blocks boot on migration issues.
  // Uses noOpLogger because the structured logger isn't built until after
  // config loads; migration is best-effort and the warning it would emit
  // (permission errors on restrictFilePermissions) is the same one the
  // main logger would surface on the next boot.
  for (const file of [wpaths.globalConfig, wpaths.projectLocalConfig]) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault, noOpLogger);
      if (migrated > 0) {
        writeErr(`[${appLabel}] Encrypted ${migrated} plaintext secret(s) in ${file}\n`);
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault });
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
      config = await configLoader.load({ cliFlags: flagsToConfigPatch(flags) });
    } else {
      throw err;
    }
  }

  // Load and decrypt sync config from ~/.wrongstack/sync.json and merge it into
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

  const logger = new DefaultLogger({ level: config.log?.level ?? 'info', file: wpaths.logFile });

  // Initialize the cross-process session registry so /sessions status works
  // and the agent status tracker can register entries later.
  try {
    const { getSessionRegistry } = await import('./session-registry.js');
    getSessionRegistry(wpaths.globalRoot);
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
  if (flags['yolo']) patch.yolo = true;
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

async function writeProjectMeta(paths: WstackPaths, projectRoot: string): Promise<void> {
  try {
    await fs.mkdir(paths.projectDir, { recursive: true });
    const meta = {
      hash: paths.projectHash,
      slug: paths.projectSlug,
      root: projectRoot,
      lastSeen: new Date().toISOString(),
    };
    await fs.writeFile(paths.projectMeta, JSON.stringify(meta, null, 2));
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
    let manifest: { projects: Array<{ name: string; root: string; slug: string; lastSeen?: string; createdAt?: string }> };
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
    } else {
      const slug = paths.projectSlug;
      const name = path.basename(projectRoot);
      manifest.projects.push({ name, root: projectRoot, slug, lastSeen: now, createdAt: now });
    }

    const writeT0 = Date.now();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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

const GITIGNORE_ENTRY = '.wrongstack/\n';

/**
 * Ensure `.gitignore` exists in the project root and contains `.wrongstack/`.
 * Idempotent — skips if the entry is already present. Best-effort — failures
 * are silently ignored so boot never blocks on gitignore maintenance.
 */
async function ensureGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      // file doesn't exist — that's fine, we'll create it
    }
    if (!content.includes('.wrongstack')) {
      const updated = content
        ? content.endsWith('\n')
          ? content + GITIGNORE_ENTRY
          : content + '\n' + GITIGNORE_ENTRY
        : GITIGNORE_ENTRY;
      await fs.writeFile(gitignorePath, updated, 'utf8');
    }
  } catch {
    // best-effort — never blocks boot
  }
}

/**
 * Remove project directories whose original `root` no longer exists on
 * disk (e.g. temp directories from tests, deleted working copies).  Runs
 * as a fire-and-forget best-effort — failures are silently ignored.
 */
async function cleanupStaleProjects(wpaths: WstackPaths): Promise<void> {
  const projectsRoot = path.dirname(wpaths.projectDir);
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist or can't be read
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(projectsRoot, entry.name, 'meta.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as { root?: string | undefined };
      if (typeof meta.root === 'string') {
        try {
          await fs.access(meta.root);
          // root still exists — keep it
        } catch {
          // root gone → remove the entire project directory
          await fs.rm(path.join(projectsRoot, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      // no readable meta.json → leave it alone (don't nuke ambiguous dirs)
    }
  }
}
