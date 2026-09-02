/**
 * The Control plane's draft model.
 *
 * Turning form state into a dispatchable command is where the guardrails live:
 * which payload shape each type takes, what makes a draft incomplete, and
 * which types are destructive enough to demand a typed confirmation. That is
 * all pure, so it is decided here rather than inside JSX.
 */

export type ControlCommandType =
  | 'steer'
  | 'btw'
  | 'queue'
  | 'abort'
  | 'spawn'
  | 'broadcast'
  | 'run-command';

export type ControlRisk = 'normal' | 'danger';

export interface ControlDraft {
  type: ControlCommandType;
  payload: Record<string, unknown>;
  /** Non-null when the draft cannot be dispatched yet; shown to the operator. */
  disabledReason: string | null;
  risk: ControlRisk;
  /** One sentence describing what dispatching will actually do. */
  summary: string;
}

export interface ControlFormState {
  type: ControlCommandType;
  steerTo: string;
  steerSubject: string;
  steerBody: string;
  spawnRole: string;
  spawnTask: string;
  abortTarget: 'leader' | 'fleet';
  broadcastSubject: string;
  broadcastBody: string;
  runCommand: string;
  runCwd: string;
}

/** The word the operator must type before a destructive dispatch is allowed. */
export function confirmWordFor(type: ControlCommandType): 'RUN' | 'ABORT' | null {
  if (type === 'run-command') return 'RUN';
  if (type === 'abort') return 'ABORT';
  return null;
}

export function buildControlDraft(form: ControlFormState): ControlDraft {
  if (form.type === 'steer' || form.type === 'btw' || form.type === 'queue') {
    const recipient = form.steerTo || 'leader';
    const verb =
      form.type === 'steer'
        ? 'Send a high-priority steer to'
        : form.type === 'btw'
          ? 'Post a non-urgent FYI (btw) to'
          : 'Queue a prompt for';
    return {
      type: form.type,
      payload: {
        to: recipient,
        subject: form.steerSubject || `HQ ${form.type}`,
        body: form.steerBody,
        // Only a steer is allowed to interrupt; btw and queue ride alongside.
        priority: form.type === 'steer' ? 'high' : 'normal',
      },
      disabledReason: form.steerBody.trim().length === 0 ? 'Message body is required.' : null,
      risk: 'normal',
      summary: `${verb} ${recipient}.`,
    };
  }

  if (form.type === 'run-command') {
    return {
      type: 'run-command',
      payload: {
        command: form.runCommand,
        ...(form.runCwd.trim() !== '' ? { cwd: form.runCwd.trim() } : {}),
      },
      disabledReason: form.runCommand.trim().length === 0 ? 'Command is required.' : null,
      risk: 'danger',
      summary:
        'Route a shell command to the client. Requires --hq-allow-exec and a token with control.execute; it is delivered as a steer, so the agent’s own permission policy still applies.',
    };
  }

  if (form.type === 'abort') {
    return {
      type: 'abort',
      payload: { target: form.abortTarget },
      // An abort with no body is still a complete command — there is nothing
      // to fill in, which is exactly why it needs the typed confirmation.
      disabledReason: null,
      risk: 'danger',
      summary:
        form.abortTarget === 'fleet'
          ? 'Abort every subagent on the selected client.'
          : 'Abort the leader run on the selected client.',
    };
  }

  if (form.type === 'spawn') {
    const task = form.spawnTask.trim();
    return {
      type: 'spawn',
      payload: { role: form.spawnRole, ...(task !== '' ? { task } : {}) },
      disabledReason: form.spawnRole.trim().length === 0 ? 'Role is required.' : null,
      risk: 'normal',
      summary: `Spawn a ${form.spawnRole} subagent${task !== '' ? ' with an initial task' : ''}.`,
    };
  }

  return {
    type: 'broadcast',
    payload: {
      subject: form.broadcastSubject || 'HQ broadcast',
      body: form.broadcastBody,
      priority: 'normal',
    },
    disabledReason: form.broadcastBody.trim().length === 0 ? 'Broadcast body is required.' : null,
    risk: 'normal',
    summary: 'Broadcast a normal-priority mailbox message to the selected client’s project.',
  };
}
