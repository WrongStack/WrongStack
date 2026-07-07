/**
 * mailbox-attach — composition glue for the agent-loop mailbox checker.
 *
 * Lives at the src root (composition layer) because it constructs the
 * concrete GlobalMailbox from coordination/ and hands the resulting
 * checker to core/ — core/ itself may only depend on the Mailbox
 * interface (architecture Rule 3, see tests/architecture/
 * package-boundaries.test.ts).
 *
 * @module mailbox-attach
 */

import { GlobalMailbox, resolveProjectDir } from './coordination/global-mailbox.js';
import { createHqPublisherFromEnv } from './hq/factory.js';
import { wstackGlobalRoot } from './utils/wstack-paths.js';
import { toErrorMessage } from './utils/error.js';
import { mailboxSessionTag, resolveMailboxIdentity } from './coordination/mailbox-tool.js';
import type { Mailbox, MailboxMessage } from './coordination/mailbox-types.js';
import type { FleetConfig } from './types/config.js';
import type { AgentInternals } from './core/agent-internals.js';
import { buildMailboxBtwAwarenessBlock, createMailboxChecker } from './core/mailbox-loop.js';
import { setBtwNote } from './core/btw.js';
import { buildFleetPulseBlock, fleetPulseSignature } from './core/fleet-pulse.js';

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
  const projectDir = resolveProjectDir(a.ctx.projectRoot, wstackGlobalRoot());
  // Pass the agent's EventBus so GlobalMailbox can emit real-time events
  // (agent_registered, agent_heartbeat, etc.) for TUI/WebUI display.
  const hqPublisher = createHqPublisherFromEnv({ clientKind: source ?? 'cli', projectRoot: a.ctx.projectRoot });
  hqPublisher?.connect();
  if (hqPublisher) {
    a.ctx.registerAbortHook(() => hqPublisher.close());
  }
  const mailbox: Mailbox = new GlobalMailbox(projectDir, a.events, hqPublisher);
  const surface = source ?? ((a.ctx.meta['source'] as 'cli' | 'webui' | undefined) ?? 'cli');
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
  let registeredAs = '';
  const ensureRegistered = (): string => {
    // Clear a stale explicit override from a previous session so the
    // resolver re-derives from the CURRENT session id.
    const derived = `${baseIdOf()}@${mailboxSessionTag(a.ctx.session.id)}`;
    if ((a.ctx.meta['globalAgentId'] as string | undefined) !== derived) {
      a.ctx.meta['globalAgentId'] = derived;
    }
    if (registeredAs !== derived) {
      registeredAs = derived;
      const identity = resolveMailboxIdentity(a.ctx);
      mailbox
        .registerAgent({
          agentId: derived,
          name: `${identity.name} [${surface}]`,
          sessionId: a.ctx.session.id,
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
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    const id = ensureRegistered();
    mailbox.heartbeat({ agentId: id }).catch(() => {
      // Silently ignore - heartbeat failures are expected during shutdown
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Register cleanup to stop heartbeat on abort. Note: there's no unregisterAgent
  // method - agents are considered offline after their heartbeat expires (60s timeout).
  a.ctx.registerAbortHook(() => {
    clearInterval(heartbeatTimer);
  });

  // Receive on the unique id AND the bare base id (plus '*' broadcasts) —
  // "send to leader" reaches every live leader session on the project.
  // Getter form: each check re-derives identity from the CURRENT session.
  const mailboxCheckerOptions = {
    mailbox,
    agentId: () => ensureRegistered(),
    aliases: [baseIdOf()],
  };
  const checkMailbox = createMailboxChecker(mailboxCheckerOptions);
  const checkMailboxAwareness = createMailboxChecker({
    ...mailboxCheckerOptions,
    include: (m) => m.type !== 'control',
    ack: false,
  });

  // Background mailbox awareness: poll while tools or long provider calls are
  // in flight, but queue the result as a BTW note so the agent only consumes it
  // at the next safe loop boundary. This is the important separation: polling
  // is continuous, conversation mutation remains serialized by the agent loop.
  const MAILBOX_AWARENESS_INTERVAL_MS = 5_000;
  let pollInFlight = false;
  let awarenessDisposed = false;
  const pollMailboxAwareness = async () => {
    if (awarenessDisposed || pollInFlight) return;
    pollInFlight = true;
    try {
      const messages = await checkMailboxAwareness();
      if (!awarenessDisposed && messages.length > 0) {
        setBtwNote(a.ctx, buildMailboxBtwAwarenessBlock(messages).text);
      }
    } catch {
      // Best-effort awareness only — a broken mailbox must not disturb work.
    } finally {
      pollInFlight = false;
    }
  };
  const awarenessTimer = setInterval(() => {
    void pollMailboxAwareness();
  }, MAILBOX_AWARENESS_INTERVAL_MS);
  awarenessTimer.unref?.();
  a.ctx.registerAbortHook(() => {
    awarenessDisposed = true;
    clearInterval(awarenessTimer);
  });

  return checkMailbox;
}

/** Min interval between registry reads for the pulse — keeps the digest
 *  from adding a file read to every iteration of a fast agent. */
const PULSE_MIN_READ_INTERVAL_MS = 30_000;

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
    const mailbox: Mailbox = new GlobalMailbox(projectDir);
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
