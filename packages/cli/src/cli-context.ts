/**
 * cli-context — Boot context initialization for the CLI main entry point.
 *
 * Consolidates the first ~150 lines of the monolithic main() function:
 *   - Pre-boot side effects (NODE_ENV, shell default)
 *   - Short-circuits (--help, --version, --desktop, --hq)
 *   - Boot() call + preflight
 *   - OAuth token persistence
 *   - Container wiring (EventBus, DI container)
 *   - Replay/record mode wiring
 *
 * Returns a `CliContext` object with all the dependencies the rest of
 * main() needs, or a numeric exit code when a short-circuit fires.
 */

import { boot } from './boot.js';
import { parseArgs } from './arg-parser.js';
import { handleHelpVersionShortCircuit } from './boot/short-circuit-flags.js';
import { handleDesktopShortCircuit } from './boot/short-circuit-desktop.js';
import { handleHqShortCircuit } from './boot/short-circuit-hq.js';
import { runPreflight } from './preflight.js';
import { applyNodeEnvDefault, applySessionShellDefault } from './preflight.js';
import { wireContainer } from './boot/container-wiring.js';
import { bindReplayToContainer } from './wiring/replay.js';
import { setOAuthTokenPersister } from '@wrongstack/providers';
import { mutateConfigProviders, normalizeKeys, writeKeysBack } from './provider-config-utils.js';
import { TOKENS } from '@wrongstack/core';

import type { EventBus, ConfigStore } from '@wrongstack/core';
import type { BootContext } from './boot.js';

// ── Context type ──────────────────────────────────────────────────────────

/** All boot-phase dependencies the rest of main() needs. */
export interface CliContext extends BootContext {
  events: EventBus;
  container: ReturnType<typeof wireContainer>['container'];
  configStore: ConfigStore;
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

  // --hq short-circuit.
  const hqExit = await handleHqShortCircuit(earlyFlags);
  if (hqExit !== null) return hqExit;

  // Full boot.
  const ctx = await boot(argv);
  if (typeof ctx === 'number') return ctx;

  const {
    config,
    vault,
    wpaths,
    cwd,
    modelsRegistry,
    renderer,
    reader,
    logger,
  } = ctx;

  // Preflight (update-notice, debug-stream).
  const { updateInfo: refreshedUpdateInfo } = await runPreflight(config, ctx.updateInfo);

  // OAuth token persistence.
  setOAuthTokenPersister((providerId, creds) => {
    void mutateConfigProviders(wpaths.globalConfig, vault, (all) => {
      const p = all[providerId];
      if (!p) return;
      const keys = normalizeKeys(p);
      const active = p.activeKey ? keys.find((k: { label: string }) => k.label === p.activeKey) : keys[0];
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
    yoloDestructive: (ctx.flags as Record<string, boolean | string | undefined>)['yolo-destructive'] === true ||
      (ctx.flags as Record<string, boolean | string | undefined>)['force-all-yolo'] === true,
    confirmDestructive: true,
  });

  // Replay / record mode.
  const replayFlag = (ctx.flags as Record<string, boolean | string | undefined>)['replay'];
  const recordFlag = (ctx.flags as Record<string, boolean | string | undefined>)['record'];
  if (typeof replayFlag === 'string' || recordFlag === true) {
    const sessionId = typeof replayFlag === 'string' ? replayFlag : `record-${Date.now()}`;
    const mode = recordFlag === true ? 'record' : 'replay';
    bindReplayToContainer({
      container,
      wpaths,
      sessionId,
      mode,
      logger,
    });
    logger.info(`replay: ProviderRunner bound in '${mode}' mode for session ${sessionId}`);
  }

  const configStore = container.resolve(TOKENS.ConfigStore);

  return {
    ...ctx,
    updateInfo: refreshedUpdateInfo,
    events,
    container,
    configStore,
  } as CliContext;
}
