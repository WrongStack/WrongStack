import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toErrorMessage } from '@wrongstack/core/utils';

/**
 * Boot phase — everything before the DI container wiring.
 * Extracted from index.ts so main() focuses on wire → execute.
 */

/**
 * Curated model-catalog overlay served from our GitHub repo. Deep-merged on
 * top of models.dev so we can add/fix providers/models without an upstream
 * fix or a release. See `packages/cli/data/README.md`.
 */
const GITHUB_PROVIDERS_OVERLAY_URL =
  'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/cli/data/providers.json';

/**
 * Resolve the bundled overlay `providers.json`. It ships at `<pkg>/data/` —
 * a sibling of both `src/` (dev) and `dist/` (published) — so `../data/…`
 * relative to this module resolves in both. Returns undefined if anything
 * about the resolution looks off (the overlay is optional).
 */
function resolveBundledOverlayFile(): string | undefined {
  try {
    return fileURLToPath(new URL('../data/providers.json', import.meta.url));
  } catch {
    return undefined;
  }
}

import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { TOKENS } from '@wrongstack/core/kernel';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, ModelsRegistry, SecretVault } from '@wrongstack/core/types';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import { isSetupProvider, SETUP_MODEL_ID, SETUP_PROVIDER_ID } from '@wrongstack/providers';
import { color, isStdinTTY, type WstackPaths, writeErr } from '@wrongstack/core/utils';
import { createDefaultContainer } from '@wrongstack/runtime';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';
import { parseArgs } from './arg-parser.js';
import { discoverAndMergeProviders } from './boot/auto-discover-providers.js';
import { maybeRestoreDefaultProfileFromBackup } from './boot/config-backup-recovery.js';
import { applySimpleUiFullAutoProfile, isSimpleUiFullAuto } from './boot/simpleui-full-auto.js';
import { maybeRunSystemPromptMenu } from './boot/system-prompt-menu.js';
import { bootConfig } from './boot-config.js';
import { ReadlineInputReader } from './input-reader.js';
import { type PickerResult, runPicker, saveToGlobalConfig } from './picker.js';
import {
  hasAnyCredential,
  LaunchAbortedError,
  persistLaunchChoices,
  runFirstRunSetup,
  runLaunchPrompts,
  runProjectCheck,
} from './pre-launch.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import { isKeylessLocalProvider, visibleModelIds } from './provider-helpers.js';
import { TerminalRenderer } from './renderer.js';
import { renderDeepHelp, renderFocusedHelp } from './subcommands/handlers/per-subcommand-help.js';
import { runUpdateCommand } from './subcommands/handlers/update.js';
import { subcommands } from './subcommands/index.js';
import type { UpdateInfo } from './update-check.js';
import { patchConfig } from './utils.js';

interface SavedDefaultStatus {
  ok: boolean;
  reason?: string;
}

async function validateSavedProviderModel(
  config: Config,
  modelsRegistry: ModelsRegistry,
): Promise<SavedDefaultStatus> {
  const providerId = config.provider;
  const modelId = config.model;
  if (!providerId || !modelId) return { ok: false, reason: 'missing provider/model' };

  // Setup mode is always usable by construction: no catalog entry, no saved
  // config entry, no credential. Every check below would (correctly) reject
  // it, so answer here instead of teaching each one about it.
  if (isSetupProvider(providerId)) return { ok: true };

  const saved = config.providers?.[providerId];
  const lookupId = saved?.type && saved.type !== providerId ? saved.type : providerId;
  const catalogProvider = await modelsRegistry.getProvider(lookupId).catch(() => undefined);
  if (!catalogProvider && !saved?.family)
    return { ok: false, reason: `provider "${providerId}" is no longer available` };

  const hasCredential =
    (catalogProvider?.envVars ?? saved?.envVars ?? []).some((envVar) =>
      Boolean(process.env[envVar]),
    ) ||
    (saved !== undefined && resolveActiveApiKey(saved) !== undefined) ||
    isKeylessLocalProvider({
      apiBase: saved?.baseUrl ?? catalogProvider?.apiBase,
      envVars: saved?.envVars ?? catalogProvider?.envVars,
    });
  if (!hasCredential) return { ok: false, reason: `provider "${providerId}" has no usable key` };

  const visible = visibleModelIds(
    providerId,
    config,
    (catalogProvider?.models ?? []).map((m) => m.id),
    saved,
  );
  if (visible.length > 0 && !visible.includes(modelId)) {
    return {
      ok: false,
      reason: `model "${modelId}" is no longer available for provider "${providerId}"`,
    };
  }
  return { ok: true };
}

/**
 * Resolve a usable `{ provider, model }` from saved config when the active
 * pointers are unset — the non-interactive (WebUI / --no-interactive) analogue
 * of the TUI's interactive picker. Mirrors the standalone WebUI's auto-select
 * (packages/webui-server start-webui.ts) so a config whose only entry is a
 * custom provider still boots instead of erroring out. Prefers an already-set
 * `config.provider`, otherwise the first saved provider; the model comes from
 * the provider's saved `models` allowlist, falling back to the catalog's first
 * model. Returns undefined when no provider yields a concrete model.
 */
export async function autoSelectSavedProvider(
  config: Config,
  modelsRegistry: ModelsRegistry,
): Promise<{ provider: string; model: string } | undefined> {
  const providers = config.providers ?? {};
  const entries =
    config.provider && providers[config.provider]
      ? ([[config.provider, providers[config.provider]]] as const)
      : Object.entries(providers);
  for (const [id, cfg] of entries) {
    if (!cfg) continue;
    let model = cfg.models?.[0];
    if (!model) {
      const catalogId = cfg.type && cfg.type !== id ? cfg.type : id;
      const catalog = await modelsRegistry.getProvider(catalogId).catch(() => undefined);
      model = catalog?.models?.[0]?.id;
    }
    if (model) return { provider: id, model };
  }
  return undefined;
}

export interface BootContext {
  config: Config;
  vault: SecretVault;
  wpaths: WstackPaths;
  cwd: string;
  projectRoot: string;
  userHome: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  logger: DefaultLogger;
  /** Set by background update check — if outdated, index.ts shows notification */
  updateInfo?: UpdateInfo | undefined;
  /** True when running in --webui/--no-interactive mode but provider/model not configured */
  needsSetup?: boolean | undefined;
}

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

function resolveBundledPromptsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'data', 'prompts');
  } catch {
    return undefined;
  }
}

/**
 * Determine whether a directory is the user's home directory. Used by the
 * startup guard to refuse launching wstack in `~` — where it would risk
 * creating a `.git` repo at the top of the user's filesystem.
 *
 * Resolves both paths so trailing slashes and relative segments are
 * normalized before the comparison. Case is compared as-is (matches
 * `os.homedir()` and `process.cwd()` output on every platform). Symlinks
 * are NOT followed: the common case (`cwd === os.homedir()` literally) is
 * what this guard targets.
 *
 * Exported for testing — the call site in {@link boot} performs the actual
 * warning + exit.
 */
export function isHomeDirectory(cwd: string, userHome: string): boolean {
  if (!cwd || !userHome) return false;
  return path.resolve(cwd) === path.resolve(userHome);
}

/**
 * Determine whether the first-run YOLO disclosure notice should be printed
 * to stderr. Exported for testing.
 *
 * @param lastChoices  Saved launch preferences from config (undefined = first run)
 * @param yoloPinned   Explicit --yolo/--no-yolo flag (undefined = not provided)
 * @param yolo         Resolved YOLO state
 */
export function shouldPrintYoloNotice(
  lastChoices: unknown,
  yoloPinned: boolean | undefined,
  yolo: boolean,
): boolean {
  return !lastChoices && yoloPinned === undefined && yolo;
}

/**
 * Boot the CLI: parse args, load config, handle subcommand dispatch
 * (early exit), run interactive prompts (project check, provider picker,
 * mode/yolo). Returns a BootContext for the wiring phase, or an exit
 * code when the run should stop here.
 */
export async function boot(argv: string[]): Promise<BootContext | number> {
  const { flags, positional } = parseArgs(argv);

  // Self-update is a recovery path: do not require valid user config, provider
  // metadata, or the DI container just to replace the installed CLI package.
  if (positional[0] === 'update') {
    const renderer = new TerminalRenderer();
    return runUpdateCommand(positional.slice(1), {
      cwd: process.cwd(),
      userHome: os.homedir(),
      renderer,
      flags,
    });
  }

  // `wstack resume <id>` is sugar for `wstack --resume <id>`.
  if (positional[0] === 'resume' && positional[1] && !subcommands['__noop_resume_marker']) {
    flags['resume'] = positional[1];
    positional.splice(0, 2);
  }

  let bootResult;
  try {
    bootResult = await bootConfig(flags);
  } catch (err) {
    writeErr(`Config error: ${toErrorMessage(err)}\n`);
    return 2;
  }
  let { paths, config, vault } = bootResult;
  // Not `const`: the `quick` intercept below consumes this token and must be
  // able to clear it, otherwise the subcommand dispatch still matches.
  let first = positional[0];

  // Only an ordinary interactive CLI launch may offer backup recovery. Keep
  // subcommands, single-shot prompts, WebUI, and explicit skip modes silent.
  const mayOfferConfigRecovery =
    isStdinTTY() &&
    (positional.length === 0 || first === 'quick') &&
    (!config.activeProfile || config.activeProfile === 'default') &&
    typeof flags['prompt'] !== 'string' &&
    !flags['webui'] &&
    !flags['no-interactive'] &&
    !flags['skip'];
  const renderer = new TerminalRenderer();
  const reader = new ReadlineInputReader({ historyFile: paths.wpaths.historyFile });
  if (mayOfferConfigRecovery) {
    const restored = await maybeRestoreDefaultProfileFromBackup({
      globalRoot: paths.wpaths.globalRoot,
      profilePath: paths.wpaths.profileConfig('default'),
      renderer,
      reader,
    });
    if (restored) {
      try {
        bootResult = await bootConfig(flags);
        ({ paths, config, vault } = bootResult);
      } catch (err) {
        writeErr(`Config error after backup restore: ${toErrorMessage(err)}\n`);
        await reader.close();
        return 2;
      }
    }
  }

  config = applySimpleUiFullAutoProfile(config, flags);
  const simpleUiFullAuto = isSimpleUiFullAuto(flags);
  const { cwd, projectRoot, userHome, wpaths, pathResolver } = paths;
  const profileConfigPath = activeProfileConfigPath(wpaths, config);
  void pathResolver; // used by callers via container binding

  // `wrongstack quick` — accept all defaults, list plugins, open TUI with F3 panel.
  // Handled here (before subcommand dispatch) so `wstack quick something` doesn't
  // accidentally fall through to single-shot mode.
  if (first === 'quick') {
    flags['quick'] = true;
    flags['tui'] = true;
    positional.splice(0, 1); // consume 'quick'
    // `first` was captured before this splice, and `quick` IS registered in
    // the subcommand table — so the dispatch check below still fired, ran
    // `quickCmd` (which returns 0) and exited without ever opening the TUI.
    // The intercept used to sit after dispatch, in `cli-main.ts`; moving it
    // here left this stale reference behind. Clear it so the interactive path
    // below owns the run.
    first = undefined;
    const plugins = config?.plugins ?? [];
    if (plugins.length === 0) {
      console.debug('[wrongstack:quick] No plugins configured');
    } else {
      for (const p of plugins) {
        const name = typeof p === 'string' ? p : p.name;
        const enabled = typeof p === 'object' && p.enabled === false ? ' (disabled)' : '';
        console.debug(`[wrongstack:quick] plugin: ${name}${enabled}`);
      }
    }
  }

  const logger = new DefaultLogger({
    level: config.log.level,
    file: wpaths.logFile,
    // Suppress stderr output in TUI mode: plugin/library log messages
    // (e.g. Telegram "getUpdates failed") write directly to stderr and
    // bypass Ink, which breaks the Static/live boundary.
    // Logs still go to the disk file for post-hoc debugging.
    stderr: !flags.tui,
  });
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    // Force a refresh attempt once per CLI process. Model metadata changes faster
    // than releases (new model ids, corrected context windows), and stale cache
    // here directly affects runtime behavior like context bars and compaction.
    // If the network is unavailable, DefaultModelsRegistry still falls back to
    // stale cache or the bundled overlay instead of failing startup.
    ttlSeconds: 0,
    // Curated overlay merged on top of models.dev: fetched from GitHub raw for
    // freshness, with the bundled file as the offline floor.
    overlayUrl: GITHUB_PROVIDERS_OVERLAY_URL,
    overlayFile: resolveBundledOverlayFile(),
    overlayCacheFile: wpaths.modelsOverlayCache,
  });

  // Quick path: subcommand dispatch — run BEFORE network I/O so
  // Lightweight subcommands such as `wstack help` and `wstack version` do not
  // wait for models.dev. The deprecated `wstack init` compatibility handler is
  // dispatched here too, but current setup flows use `wstack auth`.
  // Bound once so the narrowing survives `first` being a `let` (the `quick`
  // intercept above clears it).
  const subcommandHandler = first ? subcommands[first] : undefined;
  if (first && subcommandHandler) {
    if (flags['help'] === true || flags['h'] === true) {
      const deepSub = positional[1];
      if (deepSub && renderDeepHelp(`${first}:${deepSub}`, renderer)) {
        await reader.close();
        return 0;
      }
      if (renderFocusedHelp(first, renderer)) {
        await reader.close();
        return 0;
      }
    }

    // Create container to get the SAME skillLoader instance that the main
    // interactive CLI uses. This ensures cache invalidation after
    // /skill-install propagates correctly to /skill and other commands.
    const container = createDefaultContainer({
      config,
      wpaths,
      logger,
      modelsRegistry,
      bundledSkillsDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
      bundledPromptsDir: config.features.prompts === false ? undefined : resolveBundledPromptsDir(),
    });
    const sessionStore = container.resolve(TOKENS.SessionStore);
    const skillLoader = container.resolve(TOKENS.SkillLoader);
    const toolRegistryForSubcmd = new ToolRegistry();
    registerBuiltinToolTier({
      registry: toolRegistryForSubcmd,
      tier: normalizeTokenSavingTier(config.features.tokenSavingMode),
    });
    const code = await subcommandHandler(positional.slice(1), {
      config,
      renderer,
      reader,
      sessionStore,
      skillLoader,
      toolRegistry: toolRegistryForSubcmd,
      modelsRegistry,
      paths: wpaths,
      vault,
      cwd,
      projectRoot,
      userHome,
      flags,
    });
    await reader.close();
    return code;
  }

  // Safety guard: refuse to start when the current working directory is the
  // user's home directory. Running wstack in ~ risks creating a .git repo at
  // the top of the user's filesystem and treating every file under it as
  // project state. Utility subcommands (auth, version, etc.) were already
  // dispatched above and are not affected; this guard covers only session
  // launches (interactive, --webui, --no-interactive, quick, single-shot).
  if (isHomeDirectory(cwd, userHome)) {
    writeErr(
      `\n  ${color.red(color.bold('⚠ This is not a working directory.'))}\n` +
        `  ${color.red('Please open wstack in a project folder.')}\n\n`,
    );
    await reader.close();
    return 1;
  }

  // Background update check is handled in preflight.ts → applyPrintUpdateNotice(),
  // which has a 2-second timeout and prints the "Update available" notice.
  // No fire-and-forget here — the preflight phase owns update notifications.

  // Blocking models.dev refresh — fetches fresh catalog before app starts.
  // --no-models-refresh skips this. On timeout (15s default) or network failure,
  // falls back to cache and logs a warning; the app still boots normally.
  if (!flags['no-models-refresh']) {
    try {
      await modelsRegistry.refresh();
      logger.info('models.dev catalog refreshed');
    } catch (err) {
      const msg = toErrorMessage(err);
      logger.warn(`models.dev refresh failed (${msg}); using cached catalog`);
    }
  }

  // Auto-discover model lists for openai-compatible gateways (omniroute, …)
  // from their `/v1/models` endpoint and merge them into the catalog. Best-
  // effort: a down server or missing key is a logged no-op (cache fallback).
  try {
    await discoverAndMergeProviders({
      config,
      registry: modelsRegistry,
      cacheDir: path.dirname(wpaths.modelsCache),
      logger,
    });
  } catch (err) {
    logger.debug(`provider auto-discovery skipped: ${toErrorMessage(err)}`);
  }

  const isSingleShot = positional.length > 0 || typeof flags['prompt'] === 'string';
  // Skip interactive TTY prompts when: single-shot, --webui, or --no-interactive
  // --skip bypasses every interactive startup prompt (provider picker, launch
  // mode, indexing question) and uses saved preferences or sensible defaults.
  const isInteractiveTTY =
    isStdinTTY() && !isSingleShot && !flags['webui'] && !flags['no-interactive'] && !flags['skip'];

  if (isInteractiveTTY) {
    // If the current working directory has no .git repository, prompt the
    // user before proceeding — this lets them initialize one here instead
    // of the path resolver discovering a .git in a parent directory.
    await checkGitInCwd({ cwd, renderer, reader });

    const cont = await runProjectCheck({ projectRoot, cwd, renderer, reader });
    if (!cont) {
      await reader.close();
      return 0;
    }
  }

  // Early TUI TTY guard. The Ink TUI (run-tui.ts) requires a TTY on both stdin
  // and stdout and bails with exit 2 if either is piped. That guard runs late
  // (from execution.ts), so on an unconfigured machine the "No provider or model
  // configured" check below would fire first — both return 2, but a piped
  // `--tui` would then emit the wrong message. Hoist the TTY check here so a
  // non-interactive `--tui` always reports the interactive-terminal guidance
  // regardless of provider/model config state (see tui-smoke CI job).
  const wantsTui = flags['tui'] === true && flags['no-tui'] !== true;
  if (wantsTui && (!process.stdout.isTTY || !process.stdin.isTTY)) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    await reader.close();
    return 2;
  }

  // Provider + model selection
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const modelFlag = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  // When --webui or --no-interactive is active, skip interactive picker and require config values
  const noInteractiveMode = flags['webui'] || flags['no-interactive'];
  // Non-interactive surfaces can't run the picker, so adopt a saved provider
  // (e.g. a custom one added via /auth) when the active pointers are unset —
  // otherwise a custom-provider-only config fails the presence check below and
  // shows "No provider or model configured". The TUI reaches the picker instead.
  if (noInteractiveMode && (!config.provider || !config.model)) {
    // Explicit --provider/--model flags surface into the live config so --webui
    // boots into the ready state instead of the setup screen. Combined with the
    // `if (!(!!providerFlag && !!modelFlag))` gate below skipping registry
    // validation entirely in non-interactive mode, callers (notably CI E2E)
    // can provide any id pair to skip the auth gate — downstream provider
    // resolution is still typed, just unvalidated at boot.
    if (providerFlag && modelFlag) {
      config = patchConfig(config, { provider: providerFlag, model: modelFlag });
    } else {
      const picked = await autoSelectSavedProvider(config, modelsRegistry);
      if (picked) config = patchConfig(config, picked);
    }
  }
  if (!(!!providerFlag && !!modelFlag)) {
    if (isStdinTTY() && !noInteractiveMode) {
      let picked: PickerResult | undefined;
      let skipPicker = false;

      // --- First-run gate: nothing on this machine can reach a model ---
      // Runs BEFORE the picker. The picker lists the ~190-entry models.dev
      // catalog, none of which is usable without a credential, and cancelling
      // it exits the process — so a newcomer could never reach the TUI to run
      // `/auth`. This gate offers the four real ways in plus setup mode, so
      // there is always a path that ends inside the app.
      if (isSetupProvider(config.provider)) {
        // Already opted into setup mode on an earlier launch. Re-showing the
        // welcome screen every time would nag; a one-line reminder plus the
        // `/auth` pointer is enough, and adding a credential retires this
        // state on its own.
        skipPicker = true;
        renderer.write(
          `\n  ${color.amber('▶')} ${color.bold('Setup mode')} ${color.dim('— no model connected. Run')} ${color.bold('/auth')} ${color.dim('to connect one.')}\n\n`,
        );
      } else if (!(await hasAnyCredential(config, modelsRegistry))) {
        const outcome = await runFirstRunSetup({
          renderer,
          reader,
          modelsRegistry,
          vault,
          profileConfigPath,
          reloadConfig: async () => (await bootConfig(flags)).config,
        });
        if (outcome.kind === 'quit') {
          await reader.close();
          return 0;
        }
        if (outcome.kind === 'setup-mode') {
          config = patchConfig(config, { provider: SETUP_PROVIDER_ID, model: SETUP_MODEL_ID });
          // Persist so a relaunch goes straight back in rather than re-asking.
          // Only the top-level pointers are written — never a `providers[]`
          // entry — which is what makes the first real credential retire setup
          // mode automatically (see clearStaleProviderDefaults).
          await saveToGlobalConfig(profileConfigPath, SETUP_PROVIDER_ID, SETUP_MODEL_ID);
          skipPicker = true;
        } else {
          // Credentials landed on disk; our in-memory copy is stale. Re-read it
          // the same way the backup-restore path above does, then fall through
          // to the normal picker — which now has something real to offer.
          try {
            const reloaded = await bootConfig(flags);
            config = reloaded.config;
            vault = reloaded.vault;
          } catch (err) {
            writeErr(`Config error after setup: ${toErrorMessage(err)}\n`);
            await reader.close();
            return 2;
          }
        }
      }

      // --- Summary gate: saved provider/model from last session ---
      // Skipped when the first-run gate above already decided the surface —
      // otherwise setup mode would be announced twice and then re-confirmed.
      const savedProvider = config.provider;
      const savedModel = config.model;
      if (!skipPicker && savedProvider && savedModel) {
        const savedStatus = await validateSavedProviderModel(config, modelsRegistry);
        renderer.write(
          `\n  ${color.dim('Last settings:')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n`,
        );
        if (!savedStatus.ok) {
          renderer.writeWarning(
            `Saved provider/model is no longer usable (${savedStatus.reason ?? 'unknown reason'}); choose a provider.\n`,
          );
        } else {
          const answer = (
            await reader.readLine(
              `  ${color.amber('?')} Continue with these? ${color.dim('[Y/n/q]')} ${color.dim('(auto Y in 5s)')} `,
              { timeoutMs: 5000, defaultAnswer: 'y' },
            )
          )
            .trim()
            .toLowerCase();
          if (answer === 'q') {
            renderer.write(color.dim('  Goodbye!\n'));
            await reader.close();
            return 0;
          }
          if (answer !== 'n' && answer !== 'no') {
            // Accepted — use saved values, skip the picker entirely
            skipPicker = true;
            renderer.write(
              `\n  ${color.green('▶')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n\n`,
            );
          }
        }
      }

      if (!skipPicker) {
        picked = await runPicker({
          modelsRegistry,
          renderer,
          reader,
          config,
          defaultProvider: providerFlag ?? config.provider,
          defaultModel: modelFlag ?? config.model,
        });
      }

      if (!picked && !skipPicker) {
        if (!config.provider || !config.model) {
          // Cancelling the picker used to exit 2 with nothing printed, which
          // reads as a crash. Say what happened and name both ways forward.
          renderer.write(
            `\n  ${color.dim('No provider selected.')}\n` +
              `  ${color.dim('Run')} ${color.bold('wstack auth')} ${color.dim('to add a key or sign in, or start with no model:')}\n` +
              `  ${color.bold(`wstack --provider ${SETUP_PROVIDER_ID} --model ${SETUP_MODEL_ID}`)}\n\n`,
          );
          await reader.close();
          return 2;
        }
      }

      if (picked) {
        const prevProvider = config.provider;
        const prevModel = config.model;
        config = patchConfig(config, { provider: picked.provider, model: picked.model });
        if (picked.provider !== prevProvider || picked.model !== prevModel) {
          const saved = await saveToGlobalConfig(profileConfigPath, picked.provider, picked.model);
          if (saved) {
            renderer.writeInfo(`Saved ${picked.provider}/${picked.model} as default.\n`);
          } else {
            renderer.writeWarning(
              `Could not save ${picked.provider}/${picked.model} to config. Check permissions or disk space.\n`,
            );
          }
        }
      }
    } else if (!config.provider || !config.model) {
      writeErr(
        'No provider or model configured. Run `wstack auth`, or pass --provider <id> --model <id>.\n' +
          `To start the app with no model connected, pass --provider ${SETUP_PROVIDER_ID} --model ${SETUP_MODEL_ID}.\n`,
      );
      await reader.close();
      return 2;
    } else {
      const savedStatus = await validateSavedProviderModel(config, modelsRegistry);
      if (!savedStatus.ok) {
        writeErr(
          `Saved provider/model is no longer usable (${savedStatus.reason ?? 'unknown reason'}). Run \`wstack auth\` or pass --provider <id> --model <id>.\n`,
        );
        await reader.close();
        return 2;
      }
    }
  }

  // --webui serves the browser UI alongside the terminal REPL and is mutually
  // exclusive with the Ink TUI (both own stdout). Pin the surface to REPL so the
  // launch picker below doesn't ask TUI/REPL and let a TUI choice shadow the
  // --webui branch in execution.ts (which is checked AFTER the TUI branch).
  if (flags['webui']) {
    flags['tui'] = false;
    flags['no-tui'] = true;
  }

  // Project registration is handled by core/boot.ts → registerProjectInManifest
  // during bootConfig. No duplicate needed here.

  // Mode + YOLO + Director + Autonomy prompts
  if (isInteractiveTTY) {
    // System prompt (Lite / Standard / Pro). The gate itself lives in
    // `maybeRunSystemPromptMenu` so the non-TTY skip is unit-testable —
    // as a bare `if` here it was unreachable from any test.
    const promptMenu = await maybeRunSystemPromptMenu({
      isInteractiveTTY,
      flags,
      renderer,
      reader,
      profileConfigPath,
      paths: {
        globalDir: wpaths.globalInstructions,
        projectDir: wpaths.inProjectInstructions,
      },
    });
    if (promptMenu.aborted) {
      await reader.close();
      return 0;
    }
    if (promptMenu.changed && promptMenu.variant) {
      config = patchConfig(config, { systemPrompt: { variant: promptMenu.variant } });
    }
    if (promptMenu.persistError) {
      renderer.writeWarning(
        `Could not save system prompt variant to config: ${toErrorMessage(promptMenu.persistError)}\n`,
      );
    }

    let modePinned: 'tui' | 'repl' | undefined;
    if (flags['no-tui']) modePinned = 'repl';
    else if (flags['tui']) modePinned = 'tui';
    const yoloPinned: boolean | undefined =
      flags['no-yolo'] === true ? false : flags['yolo'] === true ? true : undefined;
    let autonomyPinned: 'off' | 'auto' | undefined;
    if (flags['no-autonomy'] === true) autonomyPinned = 'off';
    else if (flags['eternal'] === true)
      autonomyPinned = 'off'; // --eternal starts engine directly, skips launch-prompt autonomy
    else if (typeof flags['autonomy'] === 'string') {
      const v = (flags['autonomy'] as string).toLowerCase();
      autonomyPinned = v === 'off' || v === 'no' || v === 'false' ? 'off' : 'auto';
    } else if (flags['autonomy'] === true) {
      autonomyPinned = 'auto';
    }

    // Build saved preferences from config so the prompt can offer a one-line
    // "Continue with these?" summary instead of re-asking every question.
    const lastChoices = config.launch
      ? {
          mode: config.launch.mode ?? 'tui',
          yolo: config.yolo ?? true,
          autonomy: config.launch.autonomy ?? 'auto',
        }
      : undefined;

    let choices: Awaited<ReturnType<typeof runLaunchPrompts>>;
    try {
      choices = await runLaunchPrompts({
        renderer,
        reader,
        modePinned,
        yoloPinned,
        autonomyPinned,
        lastChoices,
      });
    } catch (err) {
      if (err instanceof LaunchAbortedError) {
        await reader.close();
        return 0;
      }
      throw err;
    }
    if (choices.mode === 'tui') {
      flags['tui'] = true;
      flags['no-tui'] = false;
    } else {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    if (choices.yolo !== config.yolo) config = patchConfig(config, { yolo: choices.yolo });
    flags['autonomy'] = choices.autonomy;

    // First-run YOLO disclosure: when YOLO auto-enabled on the very first
    // interactive launch and was not explicitly pinned via --yolo or
    // --no-yolo, print a one-time notice to stderr so the user is aware
    // that non-denied tool calls (shell, file writes, etc.) run without
    // confirmation.
    if (shouldPrintYoloNotice(lastChoices, yoloPinned, choices.yolo)) {
      writeErr(
        `\n  ${color.yellow('YOLO is on')}: non-denied tool calls, including shell and file writes, run without confirmation.\n` +
          `  ${color.dim('Explicit deny rules still apply. Use')} --no-yolo ${color.dim('or')} /yolo off ${color.dim('to require prompts.')}\n\n`,
      );
    }

    // --skip-index / --skip suppresses startup codebase indexing.
    if ((flags['skip-index'] || flags['skip']) && config.indexing) {
      config = patchConfig(config, {
        indexing: { ...config.indexing, onSessionStart: false },
      });
    }

    // Persist launch preferences so the next boot remembers them.
    // When --webui is active the mode is pinned to REPL (TUI owns stdout),
    // but we must NOT persist that choice — the user's last non-webui mode
    // (likely TUI) should survive so the next plain `wstack` session returns
    // to their preferred surface instead of silently landing in REPL.
    if (!simpleUiFullAuto) {
      try {
        const toPersist = flags['webui']
          ? { ...choices, mode: lastChoices?.mode ?? config.launch?.mode ?? 'tui' }
          : choices;
        await persistLaunchChoices(profileConfigPath, toPersist);
      } catch {
        // Best-effort — never blocks launch.
      }
    }

  } else {
    // When skipping interactive prompts (--webui or --no-interactive), use saved
    // preferences or sensible defaults. Director stays OFF in non-interactive mode.
    // Autonomy defaults to the configured defaultMode (now 'auto') so non-interactive
    // sessions self-drive too — unless the user explicitly opts out with --no-autonomy
    // (or sets autonomy.defaultMode: 'off' in config).
    // Launch autonomy only supports 'off' | 'auto' (no 'suggest' surface here).
    // Respect an explicit opt-out (--no-autonomy or defaultMode 'off'); otherwise
    // default to 'auto' so non-interactive sessions self-drive too.
    const nonInteractiveAutonomy: 'off' | 'auto' =
      !simpleUiFullAuto && (flags['no-autonomy'] === true || config.autonomy?.defaultMode === 'off')
        ? 'off'
        : 'auto';
    const effectiveChoices = config.launch
      ? {
          mode: flags['no-tui'] ? 'repl' : (config.launch.mode ?? 'tui'),
          yolo: config.yolo ?? true,
          autonomy: nonInteractiveAutonomy,
        }
      : {
          mode: 'repl',
          yolo: true,
          autonomy: nonInteractiveAutonomy,
        };

    if (effectiveChoices.mode === 'repl') {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    flags['autonomy'] = effectiveChoices.autonomy;
  }

  // Director Mode is permanently on.
  flags['director'] = true;

  return {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
    needsSetup: !noInteractiveMode ? false : !config.provider || !config.model,
  };
}

/**
 * Check whether the current working directory has a `.git` repository.
 * If not, prompt the user before the path resolver walks up to a parent.
 * When the parent directory contains a `.git`, also inform the user so
 * they know why the project root was resolved to a different directory.
 */
async function checkGitInCwd(opts: {
  cwd: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<void> {
  const { cwd, renderer, reader } = opts;
  const cwdGit = path.join(cwd, '.git');

  let hasCwdGit = false;
  try {
    await fs.access(cwdGit);
    hasCwdGit = true;
  } catch {
    // no .git in cwd
  }

  if (!hasCwdGit) {
    renderer.write(
      `\n  ${color.amber('○')} This folder has no ${color.bold('.git')} repository.\n`,
    );
    const answer = (
      await reader.readLine(`  ${color.amber('?')} Initialize one here? ${color.dim('[y/N]')} `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      try {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['init'], {
            cwd,
            signal: AbortSignal.timeout(10_000),
            windowsHide: true,
          });
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`git init failed with ${code}`)),
          );
        });
        renderer.write(`  ${color.green('✓')} Git repository initialized\n`);
        hasCwdGit = true;
      } catch (err) {
        renderer.writeError(`git init failed: ${toErrorMessage(err)}\n`);
      }
    }
  }

  // Check only the immediate parent — inform the user if .git exists there.
  const parentDir = path.dirname(cwd);
  if (parentDir !== cwd) {
    try {
      await fs.access(path.join(parentDir, '.git'));
      renderer.write(
        `  ${color.dim('ℹ')} A ${color.bold('.git')} repo exists in the parent directory: ${color.dim(parentDir)}\n`,
      );
    } catch {
      // parent has no .git — nothing to report
    }
  }
}
