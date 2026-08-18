/**
 * cli-context — Boot context initialization for the CLI main entry point.
 *
 * Consolidates the first ~150 lines of the monolithic main() function:
 *   - Pre-boot side effects (NODE_ENV, shell default)
 *   - Short-circuits (--help, --version, --desktop, --hq)
 *   - Interactive launch menu (TUI/REPL · WebUI · SimpleUI · HQ · Desktop)
 *   - Boot() call + preflight
 *   - OAuth token persistence
 *   - Container wiring (EventBus, DI container)
 *   - Replay/record mode wiring
 *
 * Returns a `CliContext` object with all the dependencies the rest of
 * main() needs, or a numeric exit code when a short-circuit fires.
 */

import type { EventBus } from '@wrongstack/core/kernel';
import { TOKENS } from '@wrongstack/core/kernel';
import type { ConfigStore } from '@wrongstack/core/types';
import { writeErr } from '@wrongstack/core/utils';
import { setOAuthTokenPersister } from '@wrongstack/providers';
import { parseArgs } from './arg-parser.js';
import { wireContainer } from './boot/container-wiring.js';
import {
  applyLaunchMenuToArgv,
  persistMenuChoice,
  runLaunchMenu,
  toPersistedMenuChoice,
} from './boot/launch-menu.js';
import { handleDesktopShortCircuit } from './boot/short-circuit-desktop.js';
import { handleHelpVersionShortCircuit } from './boot/short-circuit-flags.js';
import { handleHqShortCircuit } from './boot/short-circuit-hq.js';
import {
  parseWebuiSessionChildOptions,
  type WebuiSessionChildOptions,
  writeWebuiSessionChildError,
} from './boot/webui-session-child.js';
import type { BootContext } from './boot.js';
import { boot } from './boot.js';
import { ReadlineInputReader } from './input-reader.js';
import { applyNodeEnvDefault, applySessionShellDefault, runPreflight } from './preflight.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { mutateConfigProviders, normalizeKeys, writeKeysBack } from './provider-config-utils.js';
import { TerminalRenderer } from './renderer.js';

// ── Context type ──────────────────────────────────────────────────────────

/** All boot-phase dependencies the rest of main() needs. */
export interface CliContext extends BootContext {
  events: EventBus;
  container: ReturnType<typeof wireContainer>['container'];
  configStore: ConfigStore;
  webuiSessionChild?: WebuiSessionChildOptions | undefined;
}

// ── Initializer ───────────────────────────────────────────────────────────

/**
 * Run all pre-boot and boot-phase setup. Returns a `CliContext` on success,
 * or a numeric exit code when a short-circuit flag (--help, --desktop, --hq)
 * fires. When the return is a number the caller must return it immediately.
 */
export async function initializeCli(argv: string[]): Promise<CliContext | number> {
  // Pre-boot side effects (must fire before --help short-circuit).
  applyNodeEnvDefault();
  applySessionShellDefault();

  // --help / --version short-circuit.
  const earlyFlags = parseArgs(argv).flags;
  const earlyExit = await handleHelpVersionShortCircuit(argv);
  if (earlyExit !== null) return earlyExit;

  // --desktop short-circuit.
  const desktopExit = await handleDesktopShortCircuit(earlyFlags, argv);
  if (desktopExit !== null) return desktopExit;

  // Interactive launch menu — asks the user to pick TUI/REPL · WebUI ·
  // SimpleUI · HQ · Desktop when no surface flag was given and stdin is a TTY.
  // No-op when:
  //   - any surface flag is present (--webui/--simpleui/--hq/--desktop)
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
  let webuiSessionChild: WebuiSessionChildOptions | undefined;
  if (_earlyForMenu['webui-session-child'] === true) {
    try {
      webuiSessionChild = parseWebuiSessionChildOptions(_earlyForMenu) ?? undefined;
    } catch (err) {
      const readyFile =
        typeof _earlyForMenu['ready-file'] === 'string' ? _earlyForMenu['ready-file'] : undefined;
      if (readyFile) {
        await writeWebuiSessionChildError(readyFile, {
          runtimeId:
            typeof _earlyForMenu['runtime-id'] === 'string'
              ? _earlyForMenu['runtime-id']
              : undefined,
          parentShellId:
            typeof _earlyForMenu['parent-shell-id'] === 'string'
              ? _earlyForMenu['parent-shell-id']
              : undefined,
          phase: 'validate_args',
          recoverable: false,
          error: err,
        }).catch(() => undefined);
      }
      writeErr(
        `WebUI session child argument error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }
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
    if (menuResult.mode === 'desktop') {
      const desktopAfterMenu = await handleDesktopShortCircuit(augmentedFlags, effectiveArgv);
      if (desktopAfterMenu !== null) return desktopAfterMenu;
    }
    // For webui/simpleui the boot() path already honours the
    // flags (--webui / --simpleui) and --port / --host via its
    // existing surface-detection in cli-context + boot.ts. Nothing
    // else to wire here.
  }

  const effectiveFlags = parseArgs(effectiveArgv).flags;
  try {
    webuiSessionChild =
      webuiSessionChild ?? parseWebuiSessionChildOptions(effectiveFlags) ?? undefined;
  } catch (err) {
    const readyFile =
      typeof effectiveFlags['ready-file'] === 'string' ? effectiveFlags['ready-file'] : undefined;
    if (readyFile) {
      await writeWebuiSessionChildError(readyFile, {
        runtimeId:
          typeof effectiveFlags['runtime-id'] === 'string'
            ? effectiveFlags['runtime-id']
            : undefined,
        parentShellId:
          typeof effectiveFlags['parent-shell-id'] === 'string'
            ? effectiveFlags['parent-shell-id']
            : undefined,
        phase: 'validate_args',
        recoverable: false,
        error: err,
      }).catch(() => undefined);
    }
    writeErr(
      `WebUI session child argument error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (webuiSessionChild) {
    try {
      process.chdir(webuiSessionChild.workingDir);
      if (webuiSessionChild.resume && webuiSessionChild.sessionId) {
        const currentResume = effectiveFlags['resume'];
        if (typeof currentResume === 'string' && currentResume !== webuiSessionChild.sessionId) {
          throw new Error(
            `--resume ${currentResume} conflicts with --session-id ${webuiSessionChild.sessionId}`,
          );
        }
        if (currentResume !== webuiSessionChild.sessionId) {
          effectiveArgv = [...effectiveArgv, '--resume', webuiSessionChild.sessionId];
        }
      }
    } catch (err) {
      await writeWebuiSessionChildError(webuiSessionChild.readyFile, {
        protocolVersion: webuiSessionChild.protocolVersion,
        runtimeId: webuiSessionChild.runtimeId,
        parentShellId: webuiSessionChild.parentShellId,
        phase: 'validate_args',
        recoverable: false,
        error: err,
      }).catch(() => undefined);
      writeErr(
        `WebUI session child argument error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
  }

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
  // here (webui/simpleui). tui-repl is owned by the inner
  // pre-launch prompts; hq/desktop return from their short-circuits
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

  // OAuth token persistence.
  const profileConfigPath = activeProfileConfigPath(wpaths, config);
  setOAuthTokenPersister((providerId, creds) => {
    void mutateConfigProviders(profileConfigPath, vault, (all) => {
      const p = all[providerId];
      if (!p) return;
      const keys = normalizeKeys(p);
      const active = p.activeKey
        ? keys.find((k: { label: string }) => k.label === p.activeKey)
        : keys[0];
      if (!active) return;
      active.apiKey = creds.accessToken;
      active.refreshToken = creds.refreshToken;
      active.expiresAt = new Date(creds.expiresAt).toISOString();
      if (creds.accountId) active.accountId = creds.accountId;
      writeKeysBack(p, keys);
    }).catch(() => {
      // Best-effort: failed persist leaves the in-memory token valid.
    });
  });

  // Container wiring (EventBus, DI container).
  const { events, container } = wireContainer({
    config,
    wpaths,
    cwd,
    logger,
    reader,
    renderer,
    modelsRegistry,
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
    configStore,
    webuiSessionChild,
  } as CliContext;
}
