/**
 * cli-context — Boot context initialization for the CLI main entry point.
 *
 * Consolidates the first ~150 lines of the monolithic main() function:
 *   - Pre-boot side effects (NODE_ENV, shell default)
 *   - Short-circuits (--help, --version, --hq)
 *   - Interactive launch menu (TUI/REPL · WebUI · VibeUI · HQ)
 *   - Boot() call + preflight
 *   - OAuth token persistence
 *   - Container wiring (EventBus, DI container)
 *   - Replay/record mode wiring
 *
 * Returns a `CliContext` object with all the dependencies the rest of
 * main() needs, or a numeric exit code when a short-circuit fires.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { ConfigStore } from '@wrongstack/contracts/types';
import { parseArgs } from './arg-parser.js';
import { applyAsciiMode } from './boot/ascii-mode.js';
import { wireContainer } from './boot/container-wiring.js';
import {
  applyLaunchMenuToArgv,
  persistMenuChoice,
  runLaunchMenu,
  toPersistedMenuChoice,
} from './boot/launch-menu.js';
import { handleHelpVersionShortCircuit } from './boot/short-circuit-flags.js';
import { handleHqShortCircuit } from './boot/short-circuit-hq.js';
import { resolveLaunchAllowedTools } from './boot/tool-restriction-flags.js';
import type { BootContext } from './boot.js';
import { boot } from './boot.js';
import { ReadlineInputReader } from './input-reader.js';
import { applyNodeEnvDefault, applySessionShellDefault, runPreflight } from './preflight.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { TerminalRenderer } from './renderer.js';
import { installProviderPersisters } from './wiring/provider-persisters.js';

// ── Context type ──────────────────────────────────────────────────────────

/** All boot-phase dependencies the rest of main() needs. */
export interface CliContext extends BootContext {
  events: EventBus;
  container: ReturnType<typeof wireContainer>['container'];
  /** Late-bound handle the REPL prompt uses to mirror approvals to HQ. */
  approvalMirror: ReturnType<typeof wireContainer>['approvalMirror'];
  configStore: ConfigStore;
}

// ── Initializer ───────────────────────────────────────────────────────────

/**
 * Run all pre-boot and boot-phase setup. Returns a `CliContext` on success,
 * or a numeric exit code when a short-circuit flag (--help, --hq)
 * fires. When the return is a number the caller must return it immediately.
 */
export async function initializeCli(
  argv: string[],
  options: { onNonTuiLaunch?: () => void } = {},
): Promise<CliContext | number> {
  // Pre-boot side effects (must fire before --help short-circuit).
  applyNodeEnvDefault();
  applySessionShellDefault();

  // --help / --version short-circuit.
  const earlyFlags = parseArgs(argv).flags;
  applyAsciiMode(earlyFlags);
  const earlyExit = await handleHelpVersionShortCircuit(argv);
  if (earlyExit !== null) return earlyExit;

  // Interactive launch menu — asks the user to pick TUI/REPL · WebUI ·
  // VibeUI · HQ when no surface flag was given and stdin is a TTY.
  // No-op when:
  //   - any surface flag is present (--webui/--vibeui/--hq)
  //   - --no-menu is set, or --no-interactive/--skip already opt out
  //   - stdin isn't a TTY (CI, pipes, redirects)
  //   - first positional is a known subcommand (auth, mcp, …)
  //   - any positional arg is present (one-shot query)
  // See `runLaunchMenu` / `shouldSkipMenu` for the full predicate.
  //
  // We mint our own renderer + reader here so the menu doesn't depend
  // on the heavy BootContext. When the menu selects a non-TUI surface
  // we re-run the relevant short-circuit with the augmented argv so
  // existing flag parsing paths keep their single source of truth.
  const { flags: _earlyForMenu, positional: _positionalForMenu } = parseArgs(argv);
  const launchMenuReader = new ReadlineInputReader();
  let menuResult: Awaited<ReturnType<typeof runLaunchMenu>>;
  try {
    menuResult = await runLaunchMenu({
      argv,
      flags: _earlyForMenu,
      positional: _positionalForMenu,
      renderer: new TerminalRenderer(),
      reader: launchMenuReader,
      // Last-saved menu choice wiring is intentionally minimal here:
      // we only honor it when the user has *also* chosen no other
      // surface flag. The persisted record is updated lazily inside
      // boot() via a follow-up patch in the wiring layer, but the
      // menu itself stays stateless so unit tests don't need to mock
      // a ConfigStore. Users who want the saved-port shortcut without
      // the menu can pass `--no-menu --webui --port=<saved>`.
      lastChoice: undefined,
    });
  } finally {
    // The launch menu owns a short-lived readline instance. Fully release it
    // before boot creates its own reader (and before Ink later takes stdin),
    // so no listener or closed-interface state leaks across owners.
    await launchMenuReader.close();
  }
  let effectiveArgv = argv;
  if (menuResult !== null) {
    if (menuResult.cancelled) {
      // User typed `q` — exit gracefully, no error.
      return 0;
    }
    effectiveArgv = applyLaunchMenuToArgv(argv, menuResult);
    // Release TUI startup capture before entering a server's lifetime wait.
    // HQ does not return until shutdown, so restoring output after initializeCli
    // resolves would hide its connection banner until Ctrl+C.
    if (menuResult.mode !== 'tui' && menuResult.mode !== 'tui-repl') options.onNonTuiLaunch?.();
    // Re-parse so the downstream short-circuits see the augmented
    // surface flags and any user-typed --port / --host.
    const augmentedFlags = parseArgs(effectiveArgv).flags;
    // Re-run the HQ short-circuit when the menu selected HQ, so we
    // get the same single-source-of-truth behaviour as `wstack --hq`.
    if (menuResult.mode === 'hq') {
      const hqAfterMenu = await handleHqShortCircuit(augmentedFlags);
      if (hqAfterMenu !== null) return hqAfterMenu;
      // Fall through to boot() if HQ short-circuit decided not to
      // fire (e.g. HQ was already running and reported an error
      // that returned a numeric exit). In that case honour what
      // boot() decides with the augmented argv.
    }
    // For webui/vibeui the boot() path already honours the
    // flags (--webui / --vibeui) and --port / --host via its
    // existing surface-detection in cli-context + boot.ts. Nothing
    // else to wire here.
  }

  const effectiveFlags = parseArgs(effectiveArgv).flags;

  // --hq short-circuit (only reached when the menu did NOT select HQ;
  // when it did, the short-circuit above already returned).
  const hqExit = await handleHqShortCircuit(effectiveFlags);
  if (hqExit !== null) return hqExit;

  // Full boot.
  const ctx = await boot(effectiveArgv);
  if (typeof ctx === 'number') return ctx;

  // Persist the user's last menu choice so the next boot can show
  // a one-line "Continue with these?" summary gate. Best-effort —
  // we swallow errors so a corrupt config file can't break the
  // actual launch. Only surfaces that continue into boot() persist
  // here (webui/vibeui). tui-repl is owned by the inner
  // pre-launch prompts; hq returns from its short-circuit
  // before this point.
  if (menuResult !== null) {
    const persisted = toPersistedMenuChoice(menuResult);
    if (persisted) {
      try {
        await persistMenuChoice(activeProfileConfigPath(ctx.wpaths, ctx.config), persisted);
      } catch (err) {
        ctx.logger.debug(
          `launch-menu: failed to persist menu choice (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  const { config, vault, wpaths, cwd, modelsRegistry, renderer, reader, logger } = ctx;

  // Preflight (update-notice, debug-stream).
  const { updateInfo: refreshedUpdateInfo } = await runPreflight(config, ctx.updateInfo);

  // OAuth token + live model-list persistence (also installed before
  // subcommand dispatch in boot.ts — see installProviderPersisters).
  installProviderPersisters({ config, paths: wpaths, vault, logger });

  // Container wiring (EventBus, DI container).
  const { events, container, approvalMirror } = wireContainer({
    config,
    wpaths,
    cwd,
    logger,
    reader,
    renderer,
    modelsRegistry,
    launchAllowedTools: resolveLaunchAllowedTools(ctx.flags),
  });

  // Replay / record wiring moved to `runInteractive` (cli-main.ts), which is
  // the first point where the live session id exists. Binding here meant
  // `--record` had to invent one (`record-<epoch>`), producing a `.replay.jsonl`
  // sidecar with no transcript beside it. It also kept `@wrongstack/core/replay`
  // in the always-loaded boot graph for every invocation, including
  // subcommands that can never record.

  const configStore = container.resolve(TOKENS.ConfigStore);

  return {
    ...ctx,
    updateInfo: refreshedUpdateInfo,
    events,
    container,
    approvalMirror,
    configStore,
  } as CliContext;
}
