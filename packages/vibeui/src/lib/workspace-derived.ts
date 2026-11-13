import { hasAgentWork, isActiveAgent } from './agent-state';
import type { AgentEntry, ChatEntry } from './session';

/**
 * Pure views the workspace derives from session state on every render.
 * Kept free of React so the gating rules can be unit-tested directly.
 */

type AgentStatus = Pick<AgentEntry, 'status'>;

/** Agents whose finished work needs the user's eye (Stacky's attention face). */
const ATTENTION_STATUSES = [
  'failed',
  'error',
  'stopped',
  'interrupted',
  'cancelled',
  'aborted',
] as const;

export function liveAgents<T extends AgentStatus>(agents: readonly T[]): T[] {
  return agents.filter((agent) => isActiveAgent(agent.status));
}

/**
 * Session switching, creation, model changes and auto-submit wait while the
 * connection is not usable or any leader/worker/model/compaction work is pending.
 */
export function workspaceLocked(input: {
  ready: boolean;
  connection: string;
  running: boolean;
  agents: readonly AgentStatus[];
  modelPending: boolean;
  compactPending: boolean;
}): boolean {
  return (
    !input.ready ||
    input.connection !== 'open' ||
    input.running ||
    input.agents.some((agent) => isActiveAgent(agent.status)) ||
    input.modelPending ||
    input.compactPending
  );
}

/** Stop all is offered only for live work on an open, ready connection. */
export function canStopWork(input: {
  hasActiveWork: boolean;
  ready: boolean;
  connection: string;
}): boolean {
  return input.hasActiveWork && input.ready && input.connection === 'open';
}

export function latestAssistantId(messages: readonly ChatEntry[]): string | undefined {
  return messages.filter((message) => message.role === 'assistant').at(-1)?.id;
}

export function agentsNeedAttention(agents: readonly AgentEntry[]): boolean {
  return agents.some(
    (agent) =>
      hasAgentWork(agent) && (ATTENTION_STATUSES as readonly string[]).includes(agent.status),
  );
}

/**
 * Whether a final answer's first `auto="true"` next step may count down and
 * submit itself. Every condition is required: Auto autonomy with YOLO or YOLO+,
 * a reply this browser marked eligible, nothing typed or queued, the auto
 * streak not exhausted, and an idle, connected, unlocked workspace.
 */
export function autoSubmitAllowed(input: {
  prefs: Record<string, unknown>;
  autoEligible: boolean | undefined;
  hasDraft: boolean;
  queued: number;
  autoLimitReached: boolean;
  connection: string;
  ready: boolean;
  locked: boolean;
}): boolean {
  return (
    input.prefs.autonomy === 'auto' &&
    (input.prefs.yolo === true || input.prefs.yoloPlus === true) &&
    input.autoEligible === true &&
    !input.hasDraft &&
    input.queued === 0 &&
    !input.autoLimitReached &&
    input.connection === 'open' &&
    input.ready &&
    !input.locked
  );
}
