import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
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

import {
  type Config,
  color,
  DefaultLogger,
  DefaultModelsRegistry,
  isStdinTTY,
  type ModelsRegistry,
  type SecretVault,
  TOKENS,
  ToolRegistry,
  type WstackPaths,
  writeErr,
} from '@wrongstack/core';
import { createDefaultContainer } from '@wrongstack/runtime';
import { builtinToolsPack } from '@wrongstack/tools';
import { parseArgs } from './arg-parser.js';
import { discoverAndMergeProviders } from './boot/auto-discover-providers.js';
import { bootConfig } from './boot-config.js';
import { ReadlineInputReader } from './input-reader.js';
import { printLaunchHints } from './launch-hints.js';
import { type PickerResult, runPicker, saveToGlobalConfig } from './picker.js';
import {
  LaunchAbortedError,
  maybeAskAboutIndexing,
  persistLaunchChoices,
  runLaunchPrompts,
  runProjectCheck,
} from './pre-launch.js';
import { TerminalRenderer } from './renderer.js';
import { loadManifest, touchProjectInManifest } from './slash-commands/project-utils.js';
import { subcommands } from './subcommands/index.js';
import { checkForUpdate, type UpdateInfo } from './update-check.js';
import { patchConfig } from './utils.js';

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
 * Boot the CLI: parse args, load config, handle subcommand dispatch
 * (early exit), run interactive prompts (project check, provider picker,
 * mode/yolo). Returns a BootContext for the wiring phase, or an exit
 * code when the run should stop here.
 */
export async function boot(argv: string[]): Promise<BootContext | number> {
  const { flags, positional } = parseArgs(argv);

  // `wstack resume <id>` is sugar for `wstack --resume <id>`.
  if (positional[0] === 'resume' && positional[1] && !subcommands['__noop_resume_marker']) {
    flags['resume'] = positional[1];
    positional.splice(0, 2);
  }

  // `--help` / `--version` are conventional flags. Route the bare forms to the
  // `help` / `version` subcommands so they behave the same as `wstack help` /
  // `wstack version` instead of falling through to the launch path. Only when
  // no subcommand was given (so `wstack init --help` still runs `init` with a deprecation notice).
  if (positional.length === 0) {
    if (flags['help'] === true) positional.push('help');
    else if (flags['version'] === true) positional.push('version');
  }

  let bootResult;
  try {
    bootResult = await bootConfig(flags);
  } catch (err) {
    writeErr(`Config error: ${toErrorMessage(err)}\n`);
    return 2;
  }
  const { paths, config: _config, vault } = bootResult;
  let config = _config;
  const { cwd, projectRoot, userHome, wpaths, pathResolver } = paths;
  void pathResolver; // used by callers via container binding

  // `wrongstack quick` — accept all defaults, list plugins, open TUI with F3 panel.
  if (positional[0] === 'quick' && positional.length === 1) {
    flags['quick'] = true;
    flags['tui'] = true;
    // List configured plugins as debug lines (user sees them with DEBUG=1).
    for (const plugin of config.plugins ?? []) {
      console.debug(`[wrongstack:quick] plugin: ${plugin}`);
    }
    positional.splice(0, 1); // clear positional so execute() takes the TUI path (enteringTui = true)
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
  const renderer = new TerminalRenderer();
  const reader = new ReadlineInputReader({ historyFile: wpaths.historyFile });
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

  // Background update check — fires async, non-blocking.
  // If --no-check flag is set or WRONGSTACK_NO_CHECK=1, skip it.
  let updateInfo: UpdateInfo | undefined;
  if (!flags['no-check'] && !process.env['WRONGSTACK_NO_CHECK']) {
    // Fire-and-forget: boot doesn't wait, result attached to ctx for index.ts
    checkForUpdate()
      .then((info) => {
        updateInfo = info;
      })
      .catch((err) => {
        logger.debug('update check failed', { err });
      });
  }

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

  // Quick path: subcommand dispatch
  const first = positional[0];
  // `wrongstack quick` — launch directly into TUI with sensible defaults.
  // Flags are set so execute() calls runTui() with initialAgentsMonitorOpen: true.
  // Plugins are listed as debug logs (visible in log file).
  if (first === 'quick') {
    flags['quick'] = true;
    flags['tui'] = true;
    positional.splice(0, 1); // consume 'quick', don't dispatch to subcommand handler
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
  if (first && subcommands[first]) {
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
    toolRegistryForSubcmd.registerAllOrThrow(
      [...(builtinToolsPack.tools ?? [])],
      builtinToolsPack.name,
    );
    const code = await subcommands[first]?.(positional.slice(1), {
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

  // Provider + model selection
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const modelFlag = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  // When --webui or --no-interactive is active, skip interactive picker and require config values
  const noInteractiveMode = flags['webui'] || flags['no-interactive'];
  if (!(!!providerFlag && !!modelFlag)) {
    if (isStdinTTY() && !noInteractiveMode) {
      let picked: PickerResult | undefined;
      let skipPicker = false;

      // --- Summary gate: saved provider/model from last session ---
      const savedProvider = config.provider;
      const savedModel = config.model;
      if (savedProvider && savedModel) {
        renderer.write(
          `\n  ${color.dim('Last settings:')} ${color.bold(savedProvider)} / ${color.bold(savedModel)}\n`,
        );
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
          await reader.close();
          return 2;
        }
      }

      if (picked) {
        const prevProvider = config.provider;
        const prevModel = config.model;
        config = patchConfig(config, { provider: picked.provider, model: picked.model });
        if (picked.provider !== prevProvider || picked.model !== prevModel) {
          const saved = await saveToGlobalConfig(
            wpaths.globalConfig,
            picked.provider,
            picked.model,
          );
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
        'No provider or model configured. Run `wrongstack init` first, or pass --provider <id> --model <id>.\n',
      );
      await reader.close();
      return 2;
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

  // Register the current project in ~/.wrongstack/projects.json on EVERY
  // launch (create when missing, refresh lastSeen/lastWorkingDir when
  // present) — the manifest is the single source of truth all surfaces
  // (project picker, WebUI projects list, cross-session discovery) read.
  // Best-effort: a locked/corrupt manifest must never block boot.
  try {
    const created = await registerProjectAtBoot({ projectRoot, cwd, wpaths });
    if (created && isInteractiveTTY) {
      renderer.write(
        color.dim(`  ✓ Registered "${path.basename(projectRoot)}" in projects.json.\n`),
      );
    }
  } catch {
    // best-effort
  }

  // Mode + YOLO + Director + Autonomy prompts
  if (isInteractiveTTY) {
    let modePinned: 'tui' | 'repl' | undefined;
    if (flags['no-tui']) modePinned = 'repl';
    else if (flags['tui']) modePinned = 'tui';
    const yoloPinned: boolean | undefined = flags['yolo'] === true ? true : undefined;
    let directorPinned: boolean | undefined;
    if (flags['director'] === true || typeof flags['resume'] === 'string') directorPinned = true;
    else if (flags['no-director'] === true) directorPinned = false;
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
          director: config.launch.director ?? true,
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
        directorPinned,
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
    if (choices.director) flags['director'] = true;
    flags['autonomy'] = choices.autonomy;

    // Indexing question — one-time per-session decision, never persisted.
    // Large codebases can take a while to index on first launch; let the
    // user skip it. The answer overrides config.indexing.onSessionStart
    // for this session only.
    // --skip-index / --skip bypasses the question and skips indexing entirely.
    let indexingAnswer: boolean | undefined;
    if (flags['skip-index'] || flags['skip']) {
      indexingAnswer = false;
    } else {
      indexingAnswer = await maybeAskAboutIndexing({
        projectRoot,
        renderer,
        reader,
        indexingConfigured: !!config.indexing,
      });
    }
    if (indexingAnswer === false && config.indexing) {
      config = patchConfig(config, {
        indexing: { ...config.indexing, onSessionStart: false },
      });
    }

    // Persist launch preferences so the next boot remembers them.
    // When --webui is active the mode is pinned to REPL (TUI owns stdout),
    // but we must NOT persist that choice — the user's last non-webui mode
    // (likely TUI) should survive so the next plain `wstack` session returns
    // to their preferred surface instead of silently landing in REPL.
    try {
      const toPersist = flags['webui']
        ? { ...choices, mode: lastChoices?.mode ?? config.launch?.mode ?? 'tui' }
        : choices;
      await persistLaunchChoices(wpaths.globalConfig, toPersist);
    } catch {
      // Best-effort — never blocks launch.
    }

    await printLaunchHints(renderer, flags, {
      cursorFile: path.join(wpaths.cacheDir, 'hint-cursor'),
    });
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
      flags['no-autonomy'] === true || config.autonomy?.defaultMode === 'off'
        ? 'off'
        : 'auto';
    const effectiveChoices = config.launch
      ? {
          mode: flags['no-tui'] ? 'repl' : (config.launch.mode ?? 'tui'),
          yolo: config.yolo ?? true,
          director: false, // Disable director in non-interactive mode
          autonomy: nonInteractiveAutonomy,
        }
      : {
          mode: 'repl',
          yolo: true,
          director: false,
          autonomy: nonInteractiveAutonomy,
        };

    if (effectiveChoices.mode === 'repl') {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    flags['autonomy'] = effectiveChoices.autonomy;
    if (effectiveChoices.director) flags['director'] = true;
  }

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
    updateInfo,
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
        renderer.writeError(
          `git init failed: ${toErrorMessage(err)}\n`,
        );
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

/**
 * Idempotent boot-time project registration: create the projects.json
 * entry when missing, refresh lastSeen/lastWorkingDir when present.
 * Returns true when a NEW entry was created (so the caller can print a
 * one-line notice). Auto-registers without prompting — the manifest is
 * cross-surface infrastructure (picker, WebUI, agent discovery), not an
 * opt-in nicety. Rename later via `/project rename`.
 */
async function registerProjectAtBoot(opts: {
  projectRoot: string;
  cwd: string;
  wpaths: WstackPaths;
}): Promise<boolean> {
  const { projectRoot, cwd, wpaths } = opts;
  const manifest = await loadManifest(wpaths.globalConfig);
  const existed = manifest.projects.some((p) => path.resolve(p.root) === path.resolve(projectRoot));
  await touchProjectInManifest({
    projectRoot,
    globalConfigPath: wpaths.globalConfig,
    workingDir: cwd !== projectRoot ? cwd : undefined,
  });
  return !existed;
}
