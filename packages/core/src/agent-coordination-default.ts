/**
 * The production `AgentCoordinationPort`: the composition-root attach modules
 * behind one object. Hosts bind it to `AGENT_COORDINATION`
 * (`createDefaultContainer` in `@wrongstack/runtime` does), so the agent loop
 * reaches mailbox, session notes, fleet pulse and leader deliveries without
 * importing them.
 */
import type { AgentCoordinationPort } from './core/agent-coordination.js';
import type { AgentInternals } from './core/agent-internals.js';
import { drainLeaderDeliveries } from './leader-delivery-attach.js';
import { attachFleetPulse, attachMailboxChecker } from './mailbox-attach.js';
import { attachSessionNotes } from './session-note-attach.js';

export const defaultAgentCoordination: AgentCoordinationPort<AgentInternals> = {
  attachMailboxChecker: (a) => attachMailboxChecker(a),
  attachSessionNotes,
  attachFleetPulse,
  drainLeaderDeliveries,
};
