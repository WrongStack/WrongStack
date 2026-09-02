export type MailboxMessageType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'review'
  | 'control';

/**
 * Semantic category a mail type belongs to - determines its handling
 * priority, delivery guarantees, and interaction with the agent loop.
 */
export type MailboxTypeCategory =
  /** Requires a substantive response from the recipient. */
  | 'actionable'
  /** Consumed for context; no action required. */
  | 'informational'
  /** Multi-recipient envelope - routing metadata only. */
  | 'routing'
  /** Out-of-band signal handled by the runtime, not the agent. */
  | 'control_signal';

/**
 * Explicit per-type properties used for programmatic dispatch decisions.
 * This is the single source of truth - every type in the union appears
 * here, so adding a new type requires a corresponding entry.
 */
export const MAILBOX_TYPE_PROPERTIES: Record<
  MailboxMessageType,
  {
    category: MailboxTypeCategory;
    /** Is the sender expected to get a substantive response? */
    expectsReply: boolean;
    /**
     * Should this message type trigger the "Action required" acknowledgement
     * footer in the rendered mailbox block?
     *
     * This is SEPARATE from `expectsReply`:
     * - `review` expects no reply but still requires inspection -> `requiresAction: true`
     * - `ask` requires both a reply AND action -> `requiresAction: true, expectsReply: true`
     * - `result` provides evidence but expects nothing back -> both false
     */
    requiresAction: boolean;
    /** Should this type be injected inline in background delivery mode? */
    backgroundEligible: boolean;
    /** Should this type be excluded from the folded conversation block? */
    outOfBand: boolean;
    /** Render priority (lower = rendered first). */
    renderPriority: number;
    /** Human-readable description of the recipient's obligation. */
    recipientObligation: string;
    /** Human-readable description of when a sender should use this type. */
    senderGuidance: string;
  }
> = {
  note: {
    category: 'informational',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: false,
    outOfBand: false,
    renderPriority: 20,
    recipientObligation: 'Read for context; no reply needed.',
    senderGuidance: 'General-purpose FYI. Use when no more specific type applies.',
  },
  ask: {
    category: 'actionable',
    expectsReply: true,
    requiresAction: true,
    backgroundEligible: true,
    outOfBand: false,
    renderPriority: 10,
    recipientObligation: 'Answer as soon as possible — the sender is waiting.',
    senderGuidance: 'Blocking question. Only use when you need an answer to proceed.',
  },
  assign: {
    category: 'actionable',
    expectsReply: false,
    requiresAction: true,
    backgroundEligible: true,
    outOfBand: false,
    renderPriority: 10,
    recipientObligation: 'Accept or decline; act on it when current operation allows.',
    senderGuidance: 'Task delegation. Must be directed to a specific recipient (not "*").',
  },
  steer: {
    category: 'actionable',
    expectsReply: false,
    requiresAction: true,
    backgroundEligible: true,
    outOfBand: false,
    renderPriority: 0, // Always rendered first
    recipientObligation: 'Pause current approach, adjust per instruction, then resume.',
    senderGuidance: 'Mid-task direction change. The recipient is already working on something.',
  },
  btw: {
    category: 'informational',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: false,
    outOfBand: false,
    renderPriority: 30,
    recipientObligation: 'Absorb the information and stay on current task; no reply needed.',
    senderGuidance: 'Low-priority aside. Non-urgent info that can wait.',
  },
  broadcast: {
    category: 'routing',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: false,
    outOfBand: false,
    renderPriority: 20,
    recipientObligation: 'Read if addressed to you (direct recipient, alias, or "*").',
    senderGuidance: 'Multi-recipient envelope. Auto-selected when to is "*" or "@session".',
  },
  status: {
    category: 'informational',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: false,
    outOfBand: false,
    renderPriority: 40,
    recipientObligation: 'Use to avoid redundant work; never act on as a task or question.',
    senderGuidance:
      'Agent/system status update. Machine-generated, not for human-originated messages.',
  },
  result: {
    category: 'informational',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: true,
    outOfBand: false,
    renderPriority: 10,
    recipientObligation: 'Factor into next decision; treat as evidence, not a new task.',
    senderGuidance: 'Task completion notice. Share the outcome of finished work.',
  },
  review: {
    category: 'actionable',
    expectsReply: false,
    requiresAction: true,
    backgroundEligible: true,
    outOfBand: false,
    renderPriority: 10,
    recipientObligation: 'Inspect when convenient; no immediate reply required.',
    senderGuidance: 'Passive review request (code/doc/PR). No reply required.',
  },
  control: {
    category: 'control_signal',
    expectsReply: false,
    requiresAction: false,
    backgroundEligible: false,
    outOfBand: true,
    renderPriority: 999, // Never rendered
    recipientObligation:
      'Handled by the agent loop, NOT folded into conversation. "interrupt" causes cooperative halt.',
    senderGuidance: 'RESERVED for runtime use. Agents must NOT send control messages.',
  },
};
