import * as path from 'node:path';
import {
  type FileAuthorTrackerOptions,
  getSharedProjectMailbox,
  type PackageAuthorTrackerOptions,
  startPackageOutdatedWatcher,
  startTechStackConsumer,
} from '@wrongstack/core/coordination';
import type { DefaultLogger } from '@wrongstack/core/infrastructure';
import type { EventBus } from '@wrongstack/core/kernel';
import type { MultiAgentHost } from '../multi-agent.js';

/**
 * Upper bound on how long session teardown will wait for an in-flight
 * TechStack audit to deliver its report.
 *
 * The wait MUST be bounded. Teardown is on the exit path: an audit that hangs
 * (a stalled registry fetch, a wedged provider) would otherwise hold the CLI
 * open indefinitely. `execution-cleanup.ts` uses the same shape for its
 * WrongTrace telemetry — `Promise.race` against an unref'd timer — so the
 * timer alone can never keep the process alive.
 *
 * Sized to cover a normal audit (manifest read + a few registry calls) with
 * headroom, while staying well under a user's patience on Ctrl-C.
 */
const AUDIT_TEARDOWN_GRACE_MS = 45_000;

function boundAuditWait(work: Promise<void>, graceMs = AUDIT_TEARDOWN_GRACE_MS): Promise<void> {
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    // Never hold the process open for the deadline itself.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, deadline]);
}

/**
 * Pull the outcome fields out of a task result without assuming its exact type.
 *
 * Deliberately structural: `awaitTasks` resolves to a heterogeneous
 * `TaskResult[]`-shaped value whose runtime shape differs between hosts, and a
 * debug log must never be the thing that throws mid-teardown.
 */
function summarizeResult(value: unknown): string {
  if (value === null || value === undefined) return 'no result';
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (record['status'] !== undefined) parts.push(`status=${String(record['status'])}`);
  const error = record['error'] as Record<string, unknown> | undefined;
  if (error && typeof error === 'object') {
    parts.push(`error=${String(error['kind'] ?? 'unknown')}`);
    if (error['message'] !== undefined) parts.push(`message=${String(error['message'])}`);
  } else if (record['error'] !== undefined) {
    parts.push(`error=${String(record['error'])}`);
  }
  if (parts.length === 0) {
    const keys = Object.keys(record).slice(0, 6);
    return `keys=[${keys.join(',')}]`;
  }
  return parts.join(' ');
}

interface SetupDepWatcherConsumersDeps {
  dwCfg: Record<string, unknown> | undefined;
  globalRoot: string;
  projectSlug: string;
  events: EventBus;
  multiAgentHost: MultiAgentHost;
  sessionId: string;
  logger: DefaultLogger;
  teardownHandlers: (() => void)[];
  projectRoot: string;
}

/**
 * Wire the tech-stack mailbox consumer and the package-outdated watcher.
 * Both are gated on `dwCfg?.enabled` (the file-watcher plugin's depWatcher
 * config). When enabled, the tech-stack consumer polls for dep-watcher
 * messages and spawns a subagent; the package-outdated watcher notifies
 * original authors when their added packages become outdated.
 */
export function setupDepWatcherConsumers(deps: SetupDepWatcherConsumersDeps): void {
  const {
    dwCfg,
    globalRoot,
    projectSlug,
    events,
    multiAgentHost,
    sessionId,
    logger,
    teardownHandlers,
    projectRoot,
  } = deps;

  // Default-on (behaviour change, 2026-10-05). Same rationale as the gate in
  // `dep-watcher-bridge.ts`: this reads HOST config, never the plugin's merged
  // `defaultConfig`, so an absent block means "not configured" — which under the
  // old `=== true` test meant permanently off. Only an explicit `false` opts out.
  const depWatcherEnabled = dwCfg?.['enabled'] !== false;

  // ── Tech-stack mailbox consumer: auto-spawn agent on dep-watcher messages ──
  let techStackConsumerDispose: (() => void) | undefined;
  if (depWatcherEnabled) {
    // Hoisted so the catch path can unsubscribe the `session.ended` listener
    // when the consumer fails to start or dies mid-setup.
    let offSessionEnded: (() => void) | undefined;
    try {
      const projectDir = path.join(globalRoot, 'projects', projectSlug);
      const tsMailbox = getSharedProjectMailbox(projectDir, events);
      const fileAuthorOpts: FileAuthorTrackerOptions = {
        storageDir: projectDir,
        projectRoot,
      };

      // ROOT CAUSE (confirmed 2026-10-05 by live run) — read before changing this.
      //
      // The audit is not reaped mid-flight by the gracefulFinish/drain mechanics. The
      // assign arrives AFTER the leader's turn has already ended:
      //
      //   18:09:37  leader turn ENDS; finalizeExecutionCleanup emits session.ended
      //   18:09:39  EDIT2 adds zod -> dep-watcher posts the assign
      //   18:10:20  the spawned audit makes its first provider call
      //   18:10:21  exit.forced after 507ms grace, 13 handles still active
      //              (FSEventWrap = this file's own fs.watch handles)
      //
      // So `session.ended` fired while `inFlightAudits` was still EMPTY (the consumer
      // had not yet posted the assign), the drain had nothing to join, teardown
      // finished, and the audit then spawned into a session that was already closing.
      // `gracefulFinish` and the `waitUntil` registration below cannot help: they only
      // cover audits that exist BEFORE session.ended.
      //
      // The consumer is a background poll loop that keeps running past session end,
      // which is why the assign lands in that dead window.
      //
      // CONSEQUENCE FOR TESTING: `--prompt` single-shot can never exercise this path —
      // the session is over before any audit completes. Verifying the report leg
      // requires a LONG-LIVED session (REPL / headless server), not a one-shot prompt.
      // Single-shot runs will always show routed=0; that is a harness limitation, not
      // necessarily a product defect.
      //
      // In-flight audits are still registered below so that an audit spawned DURING a
      // long-lived session's teardown is joined rather than reaped.
      //
      // `gracefulFinish` alone does not save the audit: it widens the agent's
      // own budget, but `coordinator.requestFinish()` is notify-only and grants
      // no grace, and teardown only blocks on work that registered through the
      // `session.ended` `waitUntil` hook (joined to a fixed point at
      // execution-cleanup.ts:216-218) or `chimeraWork.drainAndClose()`. Without
      // registering here, `director.terminateAll()` reaps the audit mid-research
      // and its report never reaches `pkg-outdated-watcher`.
      const inFlightAudits = new Set<Promise<void>>();

      // Set the instant `session.ended` fires. The consumer is a background
      // poll loop that keeps running past session end, so without this gate an
      // assign raised during teardown spawns an audit into a session that is
      // already closing — the ordering defect above. Neither `gracefulFinish`
      // nor the `waitUntil` drain can help: both only cover audits that already
      // exist when session.ended fires.
      let sessionEnding = false;

      // Track a never-rejecting completion for `work` and auto-remove it from
      // the set once it settles.
      //
      // Defensive: not every host shape exposes a director (and a host can
      // be torn down between spawn and track). Losing tracking must degrade
      // to "teardown does not wait for this audit" — never to a throw that
      // rejects `onSpawn` and silently drops the spawn result.
      const trackAudit = (work: Promise<unknown>): void => {
        // Outcome is LOGGED, not just swallowed. `.then(ok, err)` collapsing both
        // to `undefined` makes delivered / rejected / never-resolved settle
        // identically, which is precisely why two live runs could not tell
        // "the audit was reaped" from "the audit finished but sent nothing".
        // Teardown must keep waiting either way — a rejection still has to let
        // the wait settle — but the distinction has to be observable.
        const completion = work.then(
          (value) => {
            logger.info(`[dep-watcher] audit settled ok: ${summarizeResult(value)}`);
          },
          (err: unknown) => {
            logger.info(
              `[dep-watcher] audit settled rejected: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          },
        );
        inFlightAudits.add(completion);
        void completion.finally(() => inFlightAudits.delete(completion));
      };

      // `waitUntil` is only valid DURING the synchronous `session.ended`
      // callback, so registration happens inside the listener.
      offSessionEnded = events.onPattern('session.ended', (_name, raw) => {
        // Latch BEFORE anything else: from this instant no new audit may be
        // spawned, whatever the consumer's poll loop goes on to find.
        sessionEnding = true;

        const waitUntil = (raw as { waitUntil?: (work: Promise<void>) => void } | undefined)
          ?.waitUntil;
        if (inFlightAudits.size === 0) return;
        if (typeof waitUntil !== 'function') {
          // Do NOT fail silently. A payload without `waitUntil` means this host
          // never joins the drain, so teardown will reap the audit regardless of
          // the gracefulFinish opt-in — the audit's report is silently lost. That
          // is the exact failure two live runs hit, and the silent `return`
          // buried is why it took this long to see. Surface it at warn level so
          // the next occurrence is visible in the session log.
          logger.warn(
            '[dep-watcher] session.ended carried no waitUntil with ' +
              `${inFlightAudits.size} audit(s) in flight — teardown will NOT wait for them; ` +
              'their reports are lost',
          );
          return;
        }
        for (const work of [...inFlightAudits]) waitUntil(boundAuditWait(work));
      });

      techStackConsumerDispose = startTechStackConsumer({
        mailbox: tsMailbox,
        onSpawn: async (task, name) => {
          // ORDERING GATE — the fix for the confirmed live defect.
          //
          // `session.ended` fires while the leader's turn ends, but the
          // consumer's poll loop keeps running and can pick up an assign raised
          // moments later. Spawning then puts the audit into a session that is
          // already tearing down: the drain has already joined its (empty) set,
          // `terminateAll()` has fired or is imminent, and the audit dies
          // mid-research with no report. Observed live at 18:09:37 / 18:09:39 /
          // 18:10:21 — turn ends, assign posts, audit spawns into the corpse.
          //
          // Refusing here is deliberate and is NOT a silent drop: the message is
          // logged at warn level so a lost audit is always visible. Silently
          // spawning is strictly worse — it burns a subagent and produces an
          // `aborted_by_parent` record with no explanation.
          if (sessionEnding) {
            logger.warn(
              `[dep-watcher] refusing to spawn audit "${name}": session.ended already fired. ` +
                'The audit would be reaped mid-research and its report lost.',
            );
            return { subagentId: '', taskId: '' };
          }

          // `gracefulFinish` is REQUIRED here, not an optimisation.
          //
          // The audit is background work whose deliverable is a mailbox report,
          // not a value the leader is awaiting. `onSpawn` returns as soon as the
          // task is queued, so the leader's turn can end while the audit is still
          // researching. At session end `finalizeExecutionCleanup` calls
          // `director.requestFinish()` — which notifies ONLY workers that opted
          // in — and then sweeps with `director.terminateAll()`.
          //
          // Without the opt-in the audit is skipped by that notification and
          // hard-aborted mid-research, reporting `[task stopped]` with
          // `aborted_by_parent` instead of its findings. Observed live: the
          // agent had already read the manifest and fetched npm dist-tags when
          // the sweep killed it. With it, the audit receives an in-band
          // `subagent.finish_requested` and is granted a grace window to
          // deliver its report to `pkg-outdated-watcher` during the drain.

          // A placeholder joins `inFlightAudits` SYNCHRONOUSLY, before the
          // spawn promise even exists. `session.ended` is dispatched
          // synchronously to the listener above, and teardown can begin while
          // the spawn is still pending; in that window the set would otherwise
          // be empty, the listener would register no `waitUntil`, and
          // `director.terminateAll()` would reap the audit before the spawn's
          // `.then` microtask ever ran. The placeholder later ADOPTS the real
          // `awaitTasks` completion (resolve-with-thenable), so a `waitUntil`
          // registered during the pending window still waits for the real task.
          //
          // Only when a director is already available: with no director there
          // is nothing to await through, and losing tracking must register
          // NOTHING (not even a settling placeholder) — see the
          // `withDirector: false` regression test.
          let handoff: ((work: Promise<unknown>) => void) | undefined;
          if (multiAgentHost.getDirector?.()) {
            trackAudit(
              new Promise<void>((resolve) => {
                handoff = (work) => {
                  resolve(
                    work.then(
                      () => undefined,
                      () => undefined,
                    ),
                  );
                };
              }),
            );
          }

          try {
            const spawned = await multiAgentHost.spawn(task, {
              name,
              tools: ['read', 'fetch', 'mailbox'],
              gracefulFinish: true,
            });
            // Track AFTER spawn so teardown can await this specific task.
            const director = multiAgentHost.getDirector?.();
            if (director?.awaitTasks) {
              const work = director.awaitTasks([spawned.taskId]);
              if (handoff) {
                handoff(work);
              } else {
                // Director appeared only after spawn: track directly.
                trackAudit(work);
              }
            } else {
              handoff?.(Promise.resolve());
            }
            return spawned;
          } catch (err) {
            // Spawn failed: settle the placeholder so it leaves the tracked
            // set instead of holding teardown open for the full grace window
            // on an audit that never started.
            handoff?.(Promise.resolve());
            throw err;
          }
        },
        targetAgent: (dwCfg?.['targetAgent'] as string) ?? 'tech-stack',
        consumerAgentId: 'tech-stack-consumer',
        pollIntervalMs: (dwCfg?.['pollIntervalMs'] as number) ?? 5000,
        fileAuthorOpts,
        sessionId,
        currentAgentId: 'leader',
        currentAgentName: 'Leader',
        onLog: (msg) => logger.debug(msg),
        onError: (err) =>
          logger.warn(
            `Tech-stack consumer error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Tech-stack mailbox consumer started — will auto-spawn agents on dependency changes',
      );
      // Unsubscribing is a SEPARATE teardown handler rather than a wrapper
      // around the consumer's disposer: wrapping changes the disposer identity
      // and would register a handler even when `startTechStackConsumer` returned
      // no disposer at all. Reached only after the consumer started, so this
      // always pairs with a real consumer disposer.
      if (offSessionEnded) teardownHandlers.push(offSessionEnded);
    } catch (err) {
      // The consumer never started (or died mid-setup): unsubscribe the
      // teardown listener too. Without this the subscription leaks on the
      // shared EventBus for the rest of the process lifetime — the teardown
      // push above never ran on this path, so nothing else would call it.
      offSessionEnded?.();
      offSessionEnded = undefined;
      logger.warn(`Failed to start tech-stack consumer: ${err}`);
    }
  }

  // ── Package outdated watcher: notify original authors when packages are outdated ──
  let pkgOutdatedDispose: (() => void) | undefined;
  if (depWatcherEnabled) {
    try {
      const projectDir = path.join(globalRoot, 'projects', projectSlug);
      const pkgMailbox = getSharedProjectMailbox(projectDir, events);
      const pkgTrackerOpts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'> = {
        storageDir: projectDir,
        projectRoot,
      };
      pkgOutdatedDispose = startPackageOutdatedWatcher({
        mailbox: pkgMailbox,
        packageTrackerOpts: pkgTrackerOpts,
        pollIntervalMs: (dwCfg?.['pollIntervalMs'] as number) ?? 60 * 60 * 1000, // 1 hour default
        watcherAgentId: 'pkg-outdated-watcher',
        onNotify: async (msg) => {
          await pkgMailbox.send({
            from: msg.from,
            to: msg.to,
            type: 'note',
            subject: msg.subject,
            body: msg.body,
            priority: msg.priority,
          });
        },
        onLog: (m) => logger.debug(m),
        onError: (err) =>
          logger.warn(
            `Pkg-outdated-watcher error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Package outdated watcher started — will notify agents when their added packages are outdated',
      );
    } catch (err) {
      logger.warn(`Failed to start package outdated watcher: ${err}`);
    }
  }

  if (pkgOutdatedDispose) {
    teardownHandlers.push(pkgOutdatedDispose);
  }
  if (techStackConsumerDispose) {
    teardownHandlers.push(techStackConsumerDispose);
  }
}
