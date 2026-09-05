/**
 * HQ command controller — the client-side dispatch surface for Phase 4 of the
 * HQ command center. A mutable holder (mirroring the established
 * `interruptController` pattern in cli-main.ts) that the `onCommand` handler
 * on the HQ publisher reads lazily, because several of its targets
 * (`director`, the rebound `interruptLeader`) are not yet defined at HQ-connect
 * time.
 *
 * The five command types route through the agent's own decision loop or the
 * project mailbox, so they inherit existing guardrails. `run-command` (raw
 * shell) is deliberately NOT wired here — it requires a separately-audited
 * escalation policy (operator flag + per-token `control.execute` + allowlist)
 * and is left as a stub that rejects until that policy exists.
 *
 * @module hq-command-controller
 */

import type { RemoteMailbox } from '@wrongstack/core/coordination';
import type { HqCommand, HqPublisherCommandResult } from '@wrongstack/core/hq';

/**
 * Mutable holder for the command dispatch targets. Each field is populated
 * lazily as the corresponding subsystem comes online (director on
 * `onDirectorReady`, interruptLeader rebound by the REPL/TUI, …). The
 * `onCommand` handler reads these at dispatch time, not at construction.
 */
export interface HqCommandController {
  /** Project mailbox used to deliver steer/broadcast messages. */
  steerMailbox?: RemoteMailbox | undefined;
  /** Abort the session leader's running Agent.run(). Returns true if a run was aborted. */
  interruptLeader: () => boolean;
  /** Terminate a specific subagent by id. Returns true if terminated. */
  terminateAgent?: (subagentId: string) => boolean | Promise<boolean>;
  /** Stop the entire fleet (all running/idle subagents). Returns kill count. */
  killFleet?: () => number | Promise<number>;
  /** Spawn a subagent of the given role. Returns the new subagentId. */
  spawnAgent?: (role: string, task?: string, maxIterations?: number) => Promise<string>;
  /** Derive the session-unique mailbox tag for addressing (e.g. `leader@<tag>`). */
  sessionTag: () => string;
  /**
   * The session HQ is speaking for, live.
   *
   * Steering addresses the bare `leader` alias, which EVERY leader in the
   * project answers to — a second terminal on the same project consumes the
   * same message (unread state is per reader, so both get it). Stamping the
   * session id makes `acceptMailboxMessageForSession` drop it at every other
   * leader, so an operator who picked one session in HQ reaches exactly that
   * session. Optional: without it the message stays project-wide, which is
   * the pre-existing behaviour rather than a silent drop.
   */
  sessionId?: (() => string | undefined) | undefined;
  /** Whether raw shell execution is explicitly opted-in by the operator. */
  allowRunCommand: () => boolean;
}

/**
 * Build the `onCommand` handler for an HQ publisher. The handler validates
 * the command, dispatches through the controller, and returns an ack result
 * (or throws to produce a `failed` ack — the publisher's `handleCommandBatch`
 * wraps it). Best-effort: a dispatch failure never breaks the host.
 */
export function createHqCommandDispatcher(
  controller: HqCommandController,
): (command: {
  commandId: string;
  type: string;
  payload: unknown;
}) => Promise<HqPublisherCommandResult> {
  return async (command) => {
    const cmd = command as { commandId: string; type: string; payload: Record<string, unknown> };
    try {
      const result = await dispatch(
        controller,
        cmd.commandId,
        cmd.type as HqCommand['type'],
        cmd.payload,
      );
      return result;
    } catch (err) {
      return {
        commandId: command.commandId,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Session-affinity stamp for a leader-addressed message.
 *
 * Only the bare `leader` alias is scoped. An explicit address
 * (`leader@<tag>`, a subagent id) already names one agent, and a subagent
 * delegated from another tab carries that tab's owning session — stamping it
 * with the leader's session would drop the message at the receiver instead of
 * narrowing it.
 */
function leaderSessionAffinity(
  controller: HqCommandController,
  to: string,
): { sessionAffinity: { sessionId: string } } | Record<string, never> {
  if (to.trim().toLowerCase() !== 'leader') return {};
  const sessionId = controller.sessionId?.();
  if (typeof sessionId !== 'string' || sessionId.length === 0) return {};
  return { sessionAffinity: { sessionId } };
}

async function dispatch(
  controller: HqCommandController,
  commandId: string,
  type: HqCommand['type'],
  payload: Record<string, unknown>,
): Promise<HqPublisherCommandResult> {
  switch (type) {
    case 'steer': {
      const mailbox = controller.steerMailbox;
      if (mailbox === undefined) {
        return { commandId, status: 'rejected', message: 'no mailbox available' };
      }
      const to = typeof payload['to'] === 'string' ? payload['to'] : 'leader';
      const subject = typeof payload['subject'] === 'string' ? payload['subject'] : 'HQ steer';
      const body = typeof payload['body'] === 'string' ? payload['body'] : '';
      const priority =
        payload['priority'] === 'high' ? 'high' : payload['priority'] === 'low' ? 'low' : 'normal';
      const from = `hq@${controller.sessionTag()}`;
      await mailbox.send({
        from,
        to,
        type: 'steer',
        subject,
        body,
        priority,
        ...leaderSessionAffinity(controller, to),
      });
      return { commandId, status: 'accepted', message: `steered ${to}` };
    }

    case 'btw': {
      // Non-urgent FYI. Same targeting as steer, but delivered as a `btw`
      // mailbox message so the receiving agent absorbs it as context instead
      // of treating it as a course-correction. Lands in the mailbox file
      // regardless of whether a loop is currently running.
      const mailbox = controller.steerMailbox;
      if (mailbox === undefined) {
        return { commandId, status: 'rejected', message: 'no mailbox available' };
      }
      const to = typeof payload['to'] === 'string' ? payload['to'] : 'leader';
      const subject = typeof payload['subject'] === 'string' ? payload['subject'] : 'HQ note';
      const body = typeof payload['body'] === 'string' ? payload['body'] : '';
      const priority =
        payload['priority'] === 'high' ? 'high' : payload['priority'] === 'low' ? 'low' : 'normal';
      const from = `hq@${controller.sessionTag()}`;
      await mailbox.send({
        from,
        to,
        type: 'btw',
        subject,
        body,
        priority,
        ...leaderSessionAffinity(controller, to),
      });
      return { commandId, status: 'accepted', message: `noted ${to}` };
    }

    case 'queue': {
      // Queue a prompt/note for the target. Delivered as a plain `note` the
      // agent picks up before its next step — used when the prompt should
      // wait its turn rather than steer the current operation. Like steer/btw,
      // this only writes to the mailbox; no live loop is required.
      const mailbox = controller.steerMailbox;
      if (mailbox === undefined) {
        return { commandId, status: 'rejected', message: 'no mailbox available' };
      }
      const to = typeof payload['to'] === 'string' ? payload['to'] : 'leader';
      const subject = typeof payload['subject'] === 'string' ? payload['subject'] : 'HQ prompt';
      const body = typeof payload['body'] === 'string' ? payload['body'] : '';
      const priority =
        payload['priority'] === 'high' ? 'high' : payload['priority'] === 'low' ? 'low' : 'normal';
      const from = `hq@${controller.sessionTag()}`;
      await mailbox.send({
        from,
        to,
        type: 'note',
        subject,
        body,
        priority,
        ...leaderSessionAffinity(controller, to),
      });
      return { commandId, status: 'accepted', message: `queued for ${to}` };
    }

    case 'broadcast': {
      const mailbox = controller.steerMailbox;
      if (mailbox === undefined) {
        return { commandId, status: 'rejected', message: 'no mailbox available' };
      }
      const subject = typeof payload['subject'] === 'string' ? payload['subject'] : 'HQ broadcast';
      const body = typeof payload['body'] === 'string' ? payload['body'] : '';
      const priority =
        payload['priority'] === 'high' ? 'high' : payload['priority'] === 'low' ? 'low' : 'normal';
      const from = `hq@${controller.sessionTag()}`;
      await mailbox.send({ from, to: 'all', type: 'broadcast', subject, body, priority });
      return { commandId, status: 'accepted', message: 'broadcast sent' };
    }

    case 'abort': {
      const target = typeof payload['target'] === 'string' ? payload['target'] : 'leader';
      if (target === 'leader') {
        const aborted = controller.interruptLeader();
        return {
          commandId,
          status: aborted ? 'completed' : 'accepted',
          message: aborted ? 'leader aborted' : 'no active leader run',
        };
      }
      if (target === 'fleet') {
        const killed = (await controller.killFleet?.()) ?? 0;
        return {
          commandId,
          status: 'completed',
          message: `fleet stopped (${killed} agents)`,
        };
      }
      // Specific subagent id.
      const terminated = (await controller.terminateAgent?.(target)) ?? false;
      return {
        commandId,
        status: terminated ? 'completed' : 'rejected',
        message: terminated ? `agent ${target} terminated` : `agent ${target} not found`,
      };
    }

    case 'spawn': {
      const role = typeof payload['role'] === 'string' ? payload['role'] : '';
      const task = typeof payload['task'] === 'string' ? payload['task'] : undefined;
      const maxIterations =
        typeof payload['maxIterations'] === 'number' ? payload['maxIterations'] : undefined;
      if (controller.spawnAgent === undefined) {
        return { commandId, status: 'rejected', message: 'no director active' };
      }
      const subagentId = await controller.spawnAgent(role, task, maxIterations);
      return { commandId, status: 'completed', message: `spawned ${subagentId}` };
    }

    case 'run-command': {
      // RCE gate: require explicit operator opt-in. Without it, reject every
      // run-command so a stolen client token can never gain shell access.
      if (!controller.allowRunCommand()) {
        return {
          commandId,
          status: 'rejected',
          message: 'run-command requires operator opt-in (--hq-allow-exec)',
        };
      }
      // Even with opt-in, we do NOT exec shell directly — we route through the
      // agent as a steer so the agent's own permission policy still applies.
      // A full direct-exec path is deferred until a separately-audited
      // escalation policy + allowlist exists.
      const mailbox = controller.steerMailbox;
      const command = typeof payload['command'] === 'string' ? payload['command'] : '';
      if (mailbox !== undefined && command.length > 0) {
        const from = `hq@${controller.sessionTag()}`;
        await mailbox.send({
          from,
          to: 'leader',
          type: 'steer',
          subject: 'Run command (HQ)',
          body: `Run the following shell command:\n\n\`\`\`\n${command}\n\`\`\``,
          priority: 'high',
          ...leaderSessionAffinity(controller, 'leader'),
        });
        return { commandId, status: 'accepted', message: 'run-command routed to leader as steer' };
      }
      return { commandId, status: 'rejected', message: 'cannot route run-command (no mailbox)' };
    }

    default:
      return { commandId, status: 'rejected', message: `unknown command type: ${type}` };
  }
}
