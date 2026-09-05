/**
 * mailbox-attach — composition glue for the agent-loop mailbox checker.
 *
 * Lives at the src root (composition layer) because it resolves the concrete
 * project mailbox from coordination/ and hands the resulting checker to
 * core/ — core/ itself may only depend on the Mailbox interface
 * (architecture Rule 3, see tests/architecture/package-boundaries.test.ts).
 *
 * The mailbox it resolves is the *server-backed* one: the detached project
 * owner holds the only SQLite handle and every surface reaches it over IPC.
 * This module used to construct a direct-filesystem `GlobalMailbox`, which
 * put the agent loop — registration, heartbeat, delivery, ack — on a private
 * `_mailbox.jsonl` while every UI read `_mailbox.sqlite`. That split is the
 * exact failure the project-daemon invariant exists to prevent.
 *
 * @module mailbox-attach
 */

import { resolveProjectDir } from './coordination/global-mailbox-paths.js';
import {
  MAILBOX_AWARENESS_INTERVAL_MS,
  MAILBOX_HEARTBEAT_INTERVAL_MS,
  PULSE_MIN_READ_INTERVAL_MS,
} from './coordination/mailbox-constants.js';
import { mailboxSessionTag, resolveMailboxIdentity } from './coordination/mailbox-tool.js';
import type { Mailbox, MailboxMessage } from './coordination/mailbox-types.js';
import {
  acceptMailboxMessageForSession,
  MAILBOX_TYPE_PROPERTIES,
  type MailboxSessionAffinityContext,
} from './coordination/mailbox-types.js';
import { getSharedProjectMailbox } from './coordination/remote-mailbox.js';
import type { AgentInternals } from './core/agent-internals.js';
import { setBtwNote } from './core/btw.js';
import { buildFleetPulseBlock, fleetPulseSignature } from './core/fleet-pulse.js';
import { buildMailboxBtwAwarenessBlock, createMailboxChecker } from './core/mailbox-loop.js';
import { createHqPublisherFromEnv } from './hq/factory.js';
import { JsonlReportStore } from './plugins/review-report-store.js';
import type { FleetConfig } from './types/config.js';
import { toErrorMessage } from './utils/error.js';
import { wstackGlobalRoot } from './utils/wstack-paths.js';

/**
 * Process-wide HQ mailbox publishers, keyed by project root + surface.
 *
 * The socket carries mailbox telemetry only. It deliberately does NOT declare
 * `session.summary`: that is what marks a terminal surface, and HQ would then
 * render this as a phantom "waiting for session telemetry" node and
 * orphan-evict it (terminate → reconnect churn) because it never publishes a
 * session snapshot.
 */
const mailboxHqPublishers = new Map<
  string,
  { publisher: ReturnType<typeof createHqPublisherFromEnv>; refs: number }
>();

function mailboxHqPublisherKey(projectRoot: string, source: 'cli' | 'webui'): string {
  return `${source}::${projectRoot}`;
}

function acquireMailboxHqPublisher(
  projectRoot: string,
  source: 'cli' | 'webui',
  logger: AgentInternals['logger'],
): ReturnType<typeof createHqPublisherFromEnv> {
  const key = mailboxHqPublisherKey(projectRoot, source);
  const existing = mailboxHqPublishers.get(key);
  if (existing !== undefined) {
    existing.refs += 1;
    return existing.publisher;
  }
  const publisher = createHqPublisherFromEnv({
    clientKind: source,
    projectRoot,
    logger,
    capabilities: ['telemetry.publish', 'mailbox.summary'],
  });
  publisher?.connect();
  // Cached even when HQ is disabled (undefined): the refcount still has to
  // balance, and re-deciding per Agent would re-read the config every time.
  mailboxHqPublishers.set(key, { publisher, refs: 1 });
  return publisher;
}

function releaseMailboxHqPublisher(projectRoot: string, source: 'cli' | 'webui'): void {
  const key = mailboxHqPublisherKey(projectRoot, source);
  const entry = mailboxHqPublishers.get(key);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  mailboxHqPublishers.delete(key);
  entry.publisher?.close();
}

/** Test seam: drop every cached publisher without waiting for refcounts. */
export function resetMailboxHqPublishersForTests(): void {
  for (const entry of mailboxHqPublishers.values()) entry.publisher?.close();
  mailboxHqPublishers.clear();
}

export function attachMailboxChecker(
  a: AgentInternals,
  source?: 'cli' | 'webui',
): () => Promise<MailboxMessage[]> {
  // Mailbox integration is best-effort — it must NEVER be the reason Agent
  // construction fails. Ephemeral/test contexts without a projectRoot get a
  // no-op checker, and any setup error degrades to the same.
  if (!a.ctx.projectRoot) {
    return async () => [];
  }
  try {
    return attachMailboxCheckerInner(a, source);
  } catch {
    return async () => [];
  }
}

function attachMailboxCheckerInner(
  a: AgentInternals,
  source?: 'cli' | 'webui',
): () => Promise<MailboxMessage[]> {
  // Lazy mailbox getter: re-derives projectRoot on every call so that
  // an in-process project switch (which mutates a.ctx.projectRoot) is
  // picked up automatically without re-creating the loop handler.
  const getMailbox = (): Mailbox => {
    const projectDir = resolveProjectDir(a.ctx.projectRoot, wstackGlobalRoot());
    return getSharedProjectMailbox(projectDir, a.events, hqPublisher);
  };
  // Pass the agent's EventBus so the mailbox can re-emit the project owner's
  // real-time events (agent_registered, agent_heartbeat, etc.) for TUI/WebUI
  // display.
  // One socket per PROCESS, not per Agent. `attachMailboxChecker` runs for
  // every Agent the process builds — the leader and each subagent — so a
  // per-Agent publisher meant a fleet of five workers opened five extra HQ
  // sockets that all report the same project mailbox. Worse, HQ supersedes
  // same-class sockets from one pid: each new one closed its siblings, they
  // reconnected, closed it back, and the process sat in a permanent
  // reconnect ping-pong that churned HQ's client list. Shared and refcounted,
  // there is exactly one.
  const hqPublisher = acquireMailboxHqPublisher(a.ctx.projectRoot, source ?? 'cli', a.logger);
  if (hqPublisher) {
    // Agent-level hook: the HQ publisher lives across runs, not per-run.
    a.ctx.registerAgentHook(() => releaseMailboxHqPublisher(a.ctx.projectRoot, source ?? 'cli'));
  }
  const surface = source ?? (a.ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli';
  if (!a.ctx.meta['source']) a.ctx.meta['source'] = surface;

  // SESSION-bound unique identity (`<base>@<sessionTag>`): every session
  // has its own id, so two leader sessions on the same project never
  // collide — and the identity is re-derived LIVE so an in-process session
  // swap (resume / session.new / project switch) moves the agent onto the
  // new session's identity automatically. ctx.meta.globalAgentId is kept
  // fresh for the tools and the /mailbox command.
  const baseIdOf = (): string => {
    const fieldId = a.ctx.agentId && a.ctx.agentId !== 'unknown' ? a.ctx.agentId : undefined;
    return (a.ctx.meta['agentId'] as string | undefined) ?? fieldId ?? 'leader';
  };
  /**
   * The session this agent's mailbox identity belongs to.
   *
   * `meta.sessionId` is the OWNING-session stamp: a subagent given its own
   * journal has a `ctx.session.id` that names its private transcript, not the
   * conversation that spawned it, so tagging and registering off the writer
   * filed workers under a session no surface is showing. Leaders carry no
   * stamp and keep the live re-derivation below, which is what moves them
   * onto the new identity across a resume / session.new / project switch.
   */
  const identitySessionId = (): string => {
    const owning = a.ctx.meta['sessionId'];
    return typeof owning === 'string' && owning.length > 0 ? owning : a.ctx.session.id;
  };
  let registeredAs = '';
  const ensureRegistered = (): string => {
    // Clear a stale explicit override from a previous session so the
    // resolver re-derives from the CURRENT session id.
    const derived = `${baseIdOf()}@${mailboxSessionTag(identitySessionId())}`;
    if ((a.ctx.meta['globalAgentId'] as string | undefined) !== derived) {
      a.ctx.meta['globalAgentId'] = derived;
    }
    if (registeredAs !== derived) {
      registeredAs = derived;
      const identity = resolveMailboxIdentity(a.ctx);
      getMailbox()
        .registerAgent({
          agentId: derived,
          name: `${identity.name} [${surface}]`,
          role: identity.role,
          sessionId: identitySessionId(),
          pid: process.pid,
          source: surface,
        })
        .catch((err: unknown) => {
          // Log but don't fail - registration errors shouldn't crash the agent
          a.logger.debug(`Failed to register agent ${derived}`, {
            agentId: derived,
            err: toErrorMessage(err),
          });
        });
    }
    return derived;
  };
  ensureRegistered();

  // Heartbeat keeps the registration alive (every 30 seconds) and follows
  // identity changes — after a session swap the new identity registers and
  // the old one simply goes stale (60s timeout).
  const HEARTBEAT_INTERVAL_MS = MAILBOX_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    const id = ensureRegistered();
    // Identity rides along on every heartbeat so the daemon can REBUILD this
    // row if it was pruned (>AGENT_STALE_MS, e.g. after a sleep/starvation gap,
    // or by any observer calling getAgentStatuses()). ensureRegistered() cannot
    // do it: it early-returns on an unchanged identity and never re-registers.
    // Must mirror the registerAgent payload above so a rebuilt row is identical.
    const identity = resolveMailboxIdentity(a.ctx);
    getMailbox()
      .heartbeat({
        agentId: id,
        sessionId: identitySessionId(),
        name: `${identity.name} [${surface}]`,
        role: identity.role,
        pid: process.pid,
        source: surface,
      })
      .catch(() => {
        // Silently ignore - heartbeat failures are expected during shutdown
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Register cleanup to stop heartbeat on agent teardown. Note: there's no
  // unregisterAgent method — agents are considered offline after their heartbeat
  // expires (60s timeout). Agent-level: the heartbeat runs across runs.
  a.ctx.registerAgentHook(() => {
    clearInterval(heartbeatTimer);
  });

  // Receive on the unique id AND the bare base id (plus '*' broadcasts) —
  // "send to leader" reaches every live leader session on the project.
  // Getter form: each check re-derives identity from the CURRENT session.
  const mailboxCheckerOptions = {
    mailbox: getMailbox,
    agentId: () => ensureRegistered(),
    role: () => resolveMailboxIdentity(a.ctx).role,
    aliases: [baseIdOf()],
    sessionId: () => identitySessionId(),
    // ACK is deferred to the session-affinity wrapper so messages dropped
    // by the filter are NOT marked as read by this agent.
    ack: false as const,
  };
  const checkMailbox = createMailboxChecker(mailboxCheckerOptions);

  // Session-affinity filter: wrap the checker so cross-session chimera
  // reports (those carrying a `sessionAffinity` token) are dropped at the
  // receiver for any leader whose current session id does NOT match the
  // message's `sessionAffinity.sessionId`. The wrapper composes with the
  // existing audience filter (`isMailboxMessageVisibleTo`) — a message
  // must pass BOTH filters to reach the agent-loop inbox.
  //
  // Re-derive `currentSessionId` on every call so that an in-process
  // session swap (resume / session.new / project switch) is honored
  // without recreating the checker.
  //
  // ACK ORDERING: the inner checker is created with `ack: false` so the
  // session-affinity filter runs BEFORE any read receipts are stamped.
  // Only messages that survive the filter are acked, by the wrapper,
  // in a single batched call — preserving both the batching optimization
  // and the invariant that a message is never marked "read by agent X"
  // when agent X actually dropped it.
  const reportStore = new JsonlReportStore(
    resolveProjectDir(a.ctx.projectRoot, wstackGlobalRoot()),
  );
  const sessionAffinityCtx: MailboxSessionAffinityContext = {
    resolveChimeraReportSessionId: async (reportId) => (await reportStore.get(reportId))?.sessionId,
  };
  /**
   * Filter messages by session affinity. Shared by inline and awareness
   * checkers. The `ack` parameter controls whether the wrapper batch-acks
   * accepted messages:
   *   - inline checker: ack=true (messages are delivered to the agent loop)
   *   - awareness checker: ack=false (preview only; actionable messages
   *     must stay unread so the inline checker can still deliver them)
   */
  const applySessionAffinityFilter = (
    checker: () => Promise<MailboxMessage[]>,
    ack: boolean,
  ): (() => Promise<MailboxMessage[]>) => {
    return async (): Promise<MailboxMessage[]> => {
      const currentSessionId = identitySessionId();
      // Capture the identity BEFORE awaiting the checker, so the ack is
      // stamped by the same identity that read the messages. `ensureRegistered`
      // re-derives from `ctx.session.id` on every call, so an in-process
      // session swap that lands mid-check would otherwise ack under the NEW
      // identity messages the OLD one read — leaving them unread for the new
      // session and marked read for a session that never saw them.
      //
      // `null` here means "awareness pass, do not ack" — it is the ternary,
      // not a failure mode of `ensureRegistered` (which always returns a
      // string). The `&& agentId` in the ack guard below is the narrowing
      // that lets TypeScript see that.
      const agentId = ack ? ensureRegistered() : null;
      const messages = await checker();
      const filtered: MailboxMessage[] = [];
      for (const m of messages) {
        if (await acceptMailboxMessageForSession(m, currentSessionId, sessionAffinityCtx)) {
          filtered.push(m);
        }
      }
      // Batch-ack only when requested (inline delivery). Awareness must
      // NOT ack — otherwise actionable messages are consumed before the
      // inline checker can deliver them.
      if (ack && filtered.length > 0 && agentId) {
        void getMailbox()
          .ackMany({
            acks: filtered.map((m) => ({
              messageId: m.id,
              readerId: agentId,
              read: true,
            })),
          })
          .catch(() => {});
      }
      return filtered;
    };
  };
  const sessionScopedCheckMailbox = applySessionAffinityFilter(checkMailbox, true);

  const checkMailboxAwareness = createMailboxChecker({
    ...mailboxCheckerOptions,
    // Exclude out-of-band types (control) from awareness polling.
    // Uses the canonical MAILBOX_TYPE_PROPERTIES outOfBand flag instead
    // of a hardcoded type string, so a newly-added out-of-band type is
    // automatically excluded.
    include: (m) => !MAILBOX_TYPE_PROPERTIES[m.type]?.outOfBand,
    ack: false,
  });
  const sessionScopedCheckMailboxAwareness = applySessionAffinityFilter(
    checkMailboxAwareness,
    false,
  );

  // Background mailbox awareness: poll while tools or long provider calls are
  // in flight, but queue the result as a BTW note so the agent only consumes it
  // at the next safe loop boundary. This is the important separation: polling
  // is continuous, conversation mutation remains serialized by the agent loop.
  //
  // PUSH-NOTIFICATION SHORT-CIRCUIT: the project owner emits
  // 'mailbox.message_sent' on every send() and broadcasts it to every
  // connected client, which re-emits it on this agent's EventBus. We
  // subscribe to that event and trigger an immediate (debounced) awareness
  // poll — so a message surfaces in <500ms instead of waiting up to the full
  // poll interval. Since the owner is shared, this now covers cross-process
  // sends too; the 30s interval remains as a fallback for a dropped socket.
  const AWARENESS_FALLBACK_INTERVAL_MS = MAILBOX_AWARENESS_INTERVAL_MS; // cross-process fallback
  const AWARENESS_PUSH_DEBOUNCE_MS = 500; // collapse bursts from the same sender
  let pollInFlight = false;
  let awarenessDisposed = false;
  let pushDebounceTimer: NodeJS.Timeout | null = null;

  const pollMailboxAwareness = async () => {
    if (awarenessDisposed || pollInFlight) return;
    pollInFlight = true;
    try {
      const messages = await sessionScopedCheckMailboxAwareness();
      if (
        !awarenessDisposed &&
        messages.length > 0 &&
        a.ctx.meta['coordinationContextMode'] !== 'background'
      ) {
        setBtwNote(a.ctx, buildMailboxBtwAwarenessBlock(messages).text);
      }
    } catch {
      // Best-effort awareness only — a broken mailbox must not disturb work.
    } finally {
      pollInFlight = false;
    }
  };

  // Push-triggered poll: debounce so a rapid burst of messages (e.g. a
  // subagent sending 5 results) collapses into a single poll after 500ms
  // rather than firing 5 polls.
  const triggerPushPoll = () => {
    if (awarenessDisposed) return;
    if (pushDebounceTimer !== null) clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(() => {
      pushDebounceTimer = null;
      void pollMailboxAwareness();
    }, AWARENESS_PUSH_DEBOUNCE_MS);
  };

  // Subscribe to 'mailbox.message_sent' for push-based awareness. The project
  // owner emits it on every send(); the local connection re-emits it here.
  let pushUnsub: (() => void) | null = null;
  if (a.events && typeof a.events.onPattern === 'function') {
    pushUnsub = a.events.onPattern('mailbox.message_sent', () => {
      triggerPushPoll();
    });
  }

  // Fallback polling for cross-process messages (other terminal sessions,
  // external agents via the HTTP bridge). These don't trigger the in-process
  // EventBus event, so we still need periodic polling — just less frequently.
  const awarenessTimer = setInterval(() => {
    void pollMailboxAwareness();
  }, AWARENESS_FALLBACK_INTERVAL_MS);
  awarenessTimer.unref?.();
  a.ctx.registerAgentHook(() => {
    awarenessDisposed = true;
    clearInterval(awarenessTimer);
    if (pushDebounceTimer !== null) clearTimeout(pushDebounceTimer);
    pushUnsub?.();
  });

  // Auto-compaction (drop messages read by every online agent, expired TTLs,
  // stale completed/incomplete records) is NOT started here: the detached
  // project owner runs exactly one compaction timer for the whole project
  // (`mailbox-project-server.ts` → `startAutoCompactTimer`). Starting a
  // per-agent timer would have N sessions compacting the same store.

  return sessionScopedCheckMailbox;
}

/**
 * Fleet-pulse provider: returns a fresh "[FLEET PULSE]" digest block when
 * (a) the read throttle allows, (b) at least one online peer exists, and
 * (c) the peer picture actually changed since the last injected pulse.
 * Otherwise `null`. Same best-effort posture as the mailbox checker — any
 * failure degrades to "no pulse", never to a thrown error.
 */
export function attachFleetPulse(
  a: AgentInternals,
  cfg?: FleetConfig['pulse'],
): () => Promise<{ type: 'text'; text: string } | null> {
  if (!a.ctx.projectRoot || cfg?.enabled === false) {
    return async () => null;
  }
  try {
    const projectDir = resolveProjectDir(a.ctx.projectRoot, wstackGlobalRoot());
    // No EventBus/HQ publisher here — the pulse is a read-only registry
    // consumer; the checker's mailbox instance already owns event emission.
    const mailbox: Mailbox = getSharedProjectMailbox(projectDir);
    let lastReadAt = 0;
    let lastSignature = '';
    return async () => {
      try {
        const now = Date.now();
        if (now - lastReadAt < PULSE_MIN_READ_INTERVAL_MS) return null;
        lastReadAt = now;
        const statuses = await mailbox.getAgentStatuses();
        const selfId =
          (a.ctx.meta['globalAgentId'] as string | undefined) ??
          `${a.ctx.agentId ?? 'leader'}@${mailboxSessionTag(a.ctx.session.id)}`;
        const online = statuses.filter((s) => s.online && s.agentId !== selfId);
        const signature = fleetPulseSignature(online);
        if (online.length === 0 || signature === lastSignature) return null;
        const block = buildFleetPulseBlock(statuses, {
          selfId,
          maxAgents: cfg?.maxAgents,
          maxChars: cfg?.maxChars,
        });
        if (block) lastSignature = signature;
        return block;
      } catch {
        return null;
      }
    };
  } catch {
    return async () => null;
  }
}
