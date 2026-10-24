import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, ModelsRegistry, SecretVault } from '@wrongstack/contracts/types';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultModelsRegistry, startCatalog } from '@wrongstack/core/models';
import {
  color,
  isStdinTTY,
  toErrorMessage,
  type WstackPaths,
  writeErr,
} from '@wrongstack/core/utils';
import { parseArgs } from './arg-parser.js';
import { resolveAppendedSystemPrompt } from './boot/append-system-prompt.js';
import { discoverAndMergeProviders } from './boot/auto-discover-providers.js';
import { maybeRestoreDefaultProfileFromBackup } from './boot/config-backup-recovery.js';
import { applyGoalTuiDefault } from './boot/goal-tui-default.js';
import { resolveLaunchMcpServers } from './boot/mcp-config-flag.js';
import { activateRestrictedMode } from './boot/restricted-mode.js';
import { announceSafeMode } from './boot/safe-mode.js';
import { applySimpleUiFullAutoProfile, isSimpleUiFullAuto } from './boot/simpleui-full-auto.js';
import { parseOutputFormat } from './boot/stream-json.js';
import { resolveJsonSchemaFlag } from './boot/structured-output.js';
import {
  resolveLaunchAllowedTools,
  resolveToolRestriction,
} from './boot/tool-restriction-flags.js';
import { bootConfig } from './boot-config.js';
import { applyBootLaunchChoices } from './boot-launch-choices.js';
import { resolveBootProviderModel } from './boot-provider-gate.js';
import {
  checkGitInCwd,
  isHomeDirectory,
  resolveBundledOverlayFile,
} from './boot-provider-selection.js';
import { dispatchBootSubcommand } from './boot-subcommand-dispatch.js';
import { ReadlineInputReader } from './input-reader.js';
import { runProjectCheck } from './pre-launch.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { TerminalRenderer } from './renderer.js';
import { runUpdateCommand } from './subcommands/handlers/update.js';
import { subcommands } from './subcommands/index.js';
import type { UpdateInfo } from './update-check.js';
import { installProviderPersisters } from './wiring/provider-persisters.js';

export {
  autoSelectSavedProvider,
  isHomeDirectory,
  shouldPrintYoloNotice,
} from './boot-provider-selection.js';

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

/**
 * Boot the CLI: parse args, load config, handle subcommand dispatch
 * (early exit), run interactive prompts (project check, provider picker,
 * mode/yolo). Returns a BootContext for the wiring phase, or an exit
 * code when the run should stop here.
 */
export async function boot(argv: string[]): Promise<BootContext | number> {
  const { flags, positional } = parseArgs(argv);
  if (positional[0] === 'sandbox') {
    const { runSandboxCommand } = await import('./subcommands/handlers/sandbox.js');
    return runSandboxCommand(positional.slice(1), flags, new TerminalRenderer());
  }

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

  // `wstack remote <target>` (or `--remote <target>`) runs WrongStack on another
  // machine; nothing local is loaded, so it works from any directory.
  if (positional[0] === 'remote' || typeof flags['remote'] === 'string') {
    const { runRemoteCommand } = await import('./subcommands/handlers/remote.js');
    return runRemoteCommand(
      positional[0] === 'remote' ? positional.slice(1) : positional,
      flags,
      new TerminalRenderer(),
    );
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

  // Resolve `--append-system-prompt[-file]` once, up front: a missing file is
  // a usage error, and it must fail before any picker or provider work. The
  // resolved text replaces the inline flag so downstream reads one value.
  try {
    // Validated here for the same fail-fast reason; applied to the registry
    // once it is built (setupCliPromptAndTools).
    resolveToolRestriction(flags);
    resolveLaunchAllowedTools(flags);
    parseOutputFormat(flags['output-format']);
    announceSafeMode(flags, writeErr);
    activateRestrictedMode(flags, writeErr);
    // Normalized into one inline document so later phases parse it without
    // touching the filesystem again (the working directory may change).
    const launchMcp = await resolveLaunchMcpServers(flags, paths.cwd);
    if (launchMcp) flags['mcp-config'] = JSON.stringify({ mcpServers: launchMcp });
    const schema = await resolveJsonSchemaFlag(flags['json-schema'], paths.cwd);
    if (schema) flags['json-schema'] = JSON.stringify(schema);
    const appended = await resolveAppendedSystemPrompt(flags, paths.cwd);
    delete flags['append-system-prompt-file'];
    if (appended) flags['append-system-prompt'] = appended;
    else delete flags['append-system-prompt'];
  } catch (err) {
    writeErr(`wstack: ${toErrorMessage(err)}\n`);
    return 2;
  }

  // Not `const`: the `quick` intercept below consumes this token and must be
  // able to clear it, otherwise the subcommand dispatch still matches.
  let first = positional[0];

  // Only an ordinary interactive CLI launch may offer backup recovery. Keep
  // subcommands, single-shot prompts, WebUI, and explicit skip modes silent.
  const mayOfferConfigRecovery =
    isStdinTTY() &&
    (positional.length === 0 || first === 'quick') &&
    typeof flags['prompt'] !== 'string' &&
    !flags['webui'] &&
    !flags['no-interactive'] &&
    !flags['skip'];
  // `--output-json` / `--output-format json|stream-json` promise machine
  // output on stdout (`... | jq`). Everything meant for a human — streamed
  // answer text, tool output, the session report — moves to stderr so it
  // cannot corrupt the payload.
  const machineOutput =
    flags['output-json'] === true ||
    flags['output-format'] === 'json' ||
    flags['output-format'] === 'stream-json';
  const renderer = new TerminalRenderer(machineOutput ? { out: process.stderr } : undefined);
  const reader = new ReadlineInputReader({ historyFile: paths.wpaths.historyFile });
  if (mayOfferConfigRecovery) {
    const recoveryProfile = config.activeProfile ?? 'default';
    const restored = await maybeRestoreDefaultProfileFromBackup({
      globalRoot: paths.wpaths.globalRoot,
      profilePath: paths.wpaths.profileConfig(recoveryProfile),
      profileName: recoveryProfile,
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
  // Install the OAuth persisters before ANY path below can renew a credential:
  // subcommand handlers run their own provider auto-discovery (`wstack models`,
  // `wstack modeldiag test`), and the interactive path's auto-discovery below
  // runs before cli-context.ts installs them. A renewal without the durable
  // subscription transaction rotates the refresh token on the server and drops
  // the rotated value, so the stored grant is consumed and every later renewal
  // fails with invalid_grant until the user signs in again. Re-installing later
  // is harmless — the second call replaces the first with an equivalent writer.
  installProviderPersisters({ config, paths: wpaths, vault, logger });
  const subcommandCode = await dispatchBootSubcommand({
    first,
    positional,
    flags,
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    renderer,
    reader,
    logger,
    modelsRegistry,
  });
  if (subcommandCode !== undefined) return subcommandCode;

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

  // models.dev catalog. With a usable cache on disk the app boots from it at
  // once and refreshes in the background; the capability cache, output-limit
  // index and active context window follow the refresh through the
  // registry's catalog-change signal. No cache, or a single-shot run that
  // cannot outlive a background fetch → the blocking refresh (15s timeout,
  // cache/overlay fallback). --no-models-refresh skips the network entirely.
  if (!flags['no-models-refresh']) {
    await startCatalog({
      registry: modelsRegistry,
      logger,
      shortLived: positional.length > 0 || typeof flags['prompt'] === 'string',
    });
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
  // When --webui or --no-interactive is active, skip interactive picker and require config values
  const noInteractiveMode = flags['webui'] || flags['no-interactive'];
  const providerGate = await resolveBootProviderModel({
    flags,
    config,
    vault,
    modelsRegistry,
    renderer,
    reader,
    profileConfigPath,
    noInteractiveMode,
  });
  if (providerGate.kind === 'exit') return providerGate.code;
  ({ config, vault } = providerGate);

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
  const launch = await applyBootLaunchChoices({
    isInteractiveTTY,
    simpleUiFullAuto,
    flags,
    config,
    renderer,
    reader,
    profileConfigPath,
    wpaths,
    projectRoot,
  });
  if (launch.kind === 'exit') return launch.code;
  config = launch.config;

  applyGoalTuiDefault(flags, positional);

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
