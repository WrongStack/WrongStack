/**
 * Session-establishment phase (card #7C-3), extracted verbatim from
 * `cli-main.ts` (was lines 201-261).
 *
 * Resolves the SessionStore/TokenCounter from the container, builds the
 * cross-process SessionRegistry, runs `setupSession` with the resume
 * claim/rollback closure, publishes the online-agents prompt metadata,
 * installs the live sessionRef swap, and registers the P0 kill-safety
 * fatal-salvage flush hook.
 *
 * Two contracts preserved verbatim:
 *
 * - **Resume claim/rollback** (session.ts SessionClaimHandle): the closure
 *   reserves via `sessionRegistry.reserveResume` and returns
 *   `{ rollback: claim.cancel, activate: claim.activate(payload) }`.
 *   The payload's clientType precedence (`webui/simpleui` -> `tui` -> `cli`)
 *   reads `tuiOwnsScreen` — passed in, not re-derived, so the flag
 *   resolution stays owned by the teardown-registrar phase.
 * - **sessionRef LIVE read** in the fatal-salvage hook: the hook captures
 *   `sessionRef` (the ref object, not `.current`), so /resume writer swaps
 *   stay covered without re-registration. Do not "simplify" it to capture
 *   the session directly.
 */
import * as path from 'node:path';
import { TOKENS } from '@wrongstack/core/kernel';
import { getSessionRegistry } from '@wrongstack/core/storage';
import { addFatalSalvageHook } from '@wrongstack/core/utils';
import type { CliContext } from '../cli-context.js';
import type { loadOnlineAgentsForPrompt } from '../cli-main-helpers.js';
import { setupSession } from './session.js';

/**
 * Reservation window for a boot `--resume`, and how often to push it out.
 *
 * 60s is the daemon's ceiling (`MAX_RESERVATION_MS`); anything larger is
 * clamped. The renewal interval is well inside it so a single slow IPC
 * round-trip cannot lose the claim. Mirrors the in-session picker path in
 * `boot/tui-session-resume.ts`.
 */
const BOOT_RESUME_RESERVATION_MS = 60_000;
const BOOT_RESUME_RENEW_MS = 20_000;

interface SessionEstablishmentArgs {
  /** Container used to resolve SessionStore + TokenCounter. */
  container: Pick<CliContext['container'], 'resolve'>;
  config: { provider: string; model: string };
  wpaths: Parameters<typeof setupSession>[0]['wpaths'];
  projectRoot: string;
  cwd: string;
  systemPrompt: Parameters<typeof setupSession>[0]['systemPrompt'];
  provider: Parameters<typeof setupSession>[0]['provider'];
  renderer: Parameters<typeof setupSession>[0]['renderer'];
  flags: Parameters<typeof setupSession>[0]['flags'];
  events: NonNullable<Parameters<typeof setupSession>[0]['events']>;
  logger: Parameters<typeof setupSession>[0]['logger'];
  /** Live ref so /resume writer swaps are picked up without re-wiring. */
  sessionRef: { current: { id?: string; flushSync?: () => void } | undefined };
  onlineAgents: Awaited<ReturnType<typeof loadOnlineAgentsForPrompt>>;
  /** Owned by the teardown-registrar phase; consumed here for clientType. */
  tuiOwnsScreen: boolean;
}

export async function setupSessionEstablishment(args: SessionEstablishmentArgs) {
  const {
    container,
    config,
    wpaths,
    projectRoot,
    cwd,
    systemPrompt,
    provider,
    renderer,
    flags,
    events,
    logger,
    sessionRef,
    onlineAgents,
    tuiOwnsScreen,
  } = args;

  const sessionStore = container.resolve(TOKENS.SessionStore);
  const tokenCounter = container.resolve(TOKENS.TokenCounter);
  tokenCounter.setSessionId?.(() => sessionRef.current?.id);
  const sessionRegistry = getSessionRegistry(wpaths.globalRoot);
  const sessResult = await setupSession({
    config: { model: config.model, provider: config.provider },
    wpaths,
    projectRoot,
    cwd,
    sessionStore,
    systemPrompt,
    provider,
    tokenCounter,
    renderer,
    flags,
    events,
    logger,
    claimSession: async (sessionId) => {
      const claim = await sessionRegistry.reserveResume({
        sessionId,
        projectSlug: wpaths.projectSlug,
        projectRoot,
        reservationMs: BOOT_RESUME_RESERVATION_MS,
      });
      // Boot `--resume` has the same shape as the in-session picker: the
      // reservation is taken here, the transcript is hydrated by setupSession,
      // and only then is `activate()` called. On a large journal that gap
      // outruns the reservation window, and the launch fails with "reservation
      // expired" after the whole file was already parsed. Keep the claim alive
      // for exactly as long as the hydration runs.
      //
      // Best-effort: a catalog daemon predating `renew_reservation` rejects the
      // op, which must degrade to the old behaviour rather than break boot.
      const renewTimer = setInterval(() => {
        void claim.renew(BOOT_RESUME_RESERVATION_MS).catch(() => undefined);
      }, BOOT_RESUME_RENEW_MS);
      renewTimer.unref?.();
      return {
        rollback: () => {
          clearInterval(renewTimer);
          return claim.cancel();
        },
        activate: async () => {
          clearInterval(renewTimer);
          // The window must also cover the activate round-trip itself.
          await claim.renew(BOOT_RESUME_RESERVATION_MS).catch(() => undefined);
          await claim.activate({
            sessionId,
            projectSlug: wpaths.projectSlug,
            projectRoot,
            projectName: path.basename(projectRoot),
            workingDir: cwd,
            clientType: flags.webui || flags.simpleui ? 'webui' : tuiOwnsScreen ? 'tui' : 'cli',
            pid: process.pid,
            startedAt: new Date().toISOString(),
          });
        },
      };
    },
  });
  const {
    context,
    planPath,
    session,
    attachments,
    queueStore,
    detachTodosCheckpoint,
    priorFleetState,
  } = sessResult;
  context.meta['promptOnlineAgents'] = onlineAgents;
  sessionRef.current = session;
  // P0 kill-safety: fatal paths (crash-shield error-storm exit, top-level
  // main rejection, 'exit' listeners) drain the writer synchronously via
  // this hook. It reads sessionRef LIVE, so /resume writer swaps stay
  // covered without re-registration.
  addFatalSalvageHook(() => {
    try {
      sessionRef.current?.flushSync?.();
    } catch {
      // best-effort — process is dying anyway
    }
  });

  return {
    sessionStore,
    tokenCounter,
    context,
    planPath,
    session,
    attachments,
    queueStore,
    detachTodosCheckpoint,
    priorFleetState,
    /** Full SessionResult, passed through for downstream consumers
     *  (runCliExecution, multi-agent setup read traceId/resumed* off it). */
    sessResult,
  };
}
