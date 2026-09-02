import { describe, expect, it } from 'vitest';
import type {
  Mailbox,
  MailboxAgentStatus,
  MailboxMessage,
} from '../../src/coordination/mailbox-types.js';
import {
  classifyMailboxRecipient,
  createMailboxEventPayload,
  createMailboxSnapshotPayload,
  createMailboxSnapshotPayloadFromMailbox,
  mapMailboxAgentToHqSummary,
  mapMailboxMessageToHqSummary,
} from '../../src/hq/mailbox-mapper.js';

// ============================================================================
// COMPREHENSIVE TEST DATA — Duplicate patterns, edge cases, live agent states
// ============================================================================

/** Base message for reuse in common tests */
const baseMessage: MailboxMessage = {
  id: 'msg_1',
  from: 'leader@a',
  to: '*',
  type: 'assign',
  subject: 'Review auth flow',
  body: 'Use[REDACTED:bearer_token]while reproducing the issue.',
  priority: 'high',
  readBy: { 'agent@b': '2026-06-21T12:01:00.000Z' },
  completed: false,
  timestamp: '2026-06-21T12:00:00.000Z',
  senderSessionId: 'session_1',
  taskContext: {
    taskId: 'task_1',
    agentRole: 'security-scanner',
    agentName: 'Security Scanner',
    status: 'pending',
  },
};

/** Base agent for reuse in common tests */
const baseAgent: MailboxAgentStatus = {
  agentId: 'agent@b',
  name: 'Security Scanner',
  role: 'security-scanner',
  sessionId: 'session_2',
  status: 'running',
  currentTool: 'grep',
  currentTask: 'Review auth flow',
  iterations: 4,
  toolCalls: 12,
  lastActivityAt: '2026-06-21T12:02:00.000Z',
  lastSeenAt: '2026-06-21T12:02:00.000Z',
  online: true,
  pid: 123,
  source: 'cli',
};

// ============================================================================
// DUPLICATE MESSAGE PATTERNS — Same task, multiple messages
// ============================================================================

/** First message in a thread — unresponded */
const threadMsg1: MailboxMessage = {
  id: 'msg_thread_1',
  from: 'leader@x',
  to: 'bug-hunter@y',
  type: 'assign',
  subject: 'Fix null deref in auth.ts',
  body: 'Found a null deref at line 42 in auth.ts. Can you investigate?',
  priority: 'high',
  readBy: {},
  completed: false,
  timestamp: '2026-06-22T08:00:00.000Z',
  senderSessionId: 'session_leader_1',
  taskContext: {
    taskId: 'task_null_deref',
    agentRole: 'bug-hunter',
    agentName: 'Bug Hunter',
    status: 'pending',
  },
};

/** Duplicate: same task sent to different agent (round-robin or retry) */
const threadMsg1Duplicate: MailboxMessage = {
  ...threadMsg1,
  id: 'msg_thread_1_dup',
  from: 'leader@x',
  to: 'refactor-planner@z',
  timestamp: '2026-06-22T08:00:05.000Z', // 5 seconds later
  taskContext: {
    taskId: 'task_null_deref',
    agentRole: 'refactor-planner',
    agentName: 'Refactor Planner',
    status: 'pending',
  },
};

/** Second message: agent acknowledged */
const threadMsg2: MailboxMessage = {
  id: 'msg_thread_2',
  from: 'bug-hunter@y',
  to: 'leader@x',
  type: 'note',
  subject: 'Re: Fix null deref in auth.ts',
  body: 'Looking at it now. Will update shortly.',
  priority: 'normal',
  readBy: { 'leader@x': '2026-06-22T08:01:30.000Z' },
  completed: false,
  timestamp: '2026-06-22T08:01:00.000Z',
  senderSessionId: 'session_bug_hunter_1',
  taskContext: {
    taskId: 'task_null_deref',
    agentRole: 'bug-hunter',
    agentName: 'Bug Hunter',
    status: 'in_progress',
  },
};

/** Duplicate: same acknowledgment to broadcast (notify all) */
const threadMsg2Broadcast: MailboxMessage = {
  ...threadMsg2,
  id: 'msg_thread_2_broadcast',
  to: '*',
  readBy: {}, // explicitly empty — broadcast not yet read
  timestamp: '2026-06-22T08:01:10.000Z', // earlier than direct reply
};

/** Third message: completed successfully */
const threadMsg3Completed: MailboxMessage = {
  id: 'msg_thread_3',
  from: 'bug-hunter@y',
  to: 'leader@x',
  type: 'result',
  subject: 'Re: Fix null deref in auth.ts',
  body: 'Fixed the null deref. Added null check at line 42.',
  priority: 'normal',
  readBy: { 'leader@x': '2026-06-22T08:15:00.000Z' },
  completed: true,
  completedBy: 'bug-hunter@y',
  completedAt: '2026-06-22T08:14:00.000Z',
  outcome: 'Fixed null deref in auth.ts:42. Added guard: if (!user) throw new NotFoundError()',
  timestamp: '2026-06-22T08:14:00.000Z',
  senderSessionId: 'session_bug_hunter_1',
  taskContext: {
    taskId: 'task_null_deref',
    agentRole: 'bug-hunter',
    agentName: 'Bug Hunter',
    status: 'completed',
  },
};

/** Duplicate of completed — same outcome sent to monitoring/audit */
const threadMsg3Duplicate: MailboxMessage = {
  ...threadMsg3Completed,
  id: 'msg_thread_3_dup',
  to: 'audit@system',
  timestamp: '2026-06-22T08:14:05.000Z',
};

// ============================================================================
// VARIOUS MESSAGE TYPES — assign, result, note, ask, steer, btw, broadcast
// ============================================================================

const variousTypeMessages: MailboxMessage[] = [
  {
    id: 'msg_assign',
    from: 'leader@a',
    to: 'worker@b',
    type: 'assign',
    subject: 'New task assigned',
    body: 'Please analyze the codebase for security issues.',
    priority: 'high',
    readBy: {},
    completed: false,
    timestamp: '2026-06-22T10:00:00.000Z',
    senderSessionId: 'session_a',
    taskContext: {
      taskId: 'task_security',
      agentRole: 'security-scanner',
      agentName: 'Security Scanner',
      status: 'pending',
    },
  },
  {
    id: 'msg_result',
    from: 'worker@b',
    to: 'leader@a',
    type: 'result',
    subject: 'Task completed',
    body: 'Found 3 critical issues.',
    priority: 'normal',
    readBy: { 'leader@a': '2026-06-22T10:30:00.000Z' },
    completed: true,
    completedBy: 'worker@b',
    completedAt: '2026-06-22T10:29:00.000Z',
    outcome: 'security-scan: 3 critical, 5 high, 2 medium findings',
    timestamp: '2026-06-22T10:29:00.000Z',
    senderSessionId: 'session_b',
    taskContext: {
      taskId: 'task_security',
      agentRole: 'security-scanner',
      agentName: 'Security Scanner',
      status: 'completed',
    },
  },
  {
    id: 'msg_note',
    from: 'worker@c',
    to: 'team@',
    type: 'note',
    subject: 'FYI: Found a memory leak',
    body: 'Noticed a potential memory leak in the session store.',
    priority: 'normal',
    readBy: { 'leader@a': '2026-06-22T11:00:00.000Z', 'worker@b': '2026-06-22T11:05:00.000Z' },
    completed: false,
    timestamp: '2026-06-22T10:55:00.000Z',
    senderSessionId: 'session_c',
  },
  {
    id: 'msg_ask',
    from: 'worker@d',
    to: 'leader@a',
    type: 'ask',
    subject: 'Clarification needed',
    body: 'Should I prioritize the refactor or the bug fix?',
    priority: 'high',
    readBy: {},
    completed: false,
    timestamp: '2026-06-22T11:30:00.000Z',
    senderSessionId: 'session_d',
  },
  {
    id: 'msg_steer',
    from: 'leader@a',
    to: 'worker@e',
    type: 'steer',
    subject: 'Change approach',
    body: 'Focus on performance improvements instead.',
    priority: 'normal',
    readBy: { 'worker@e': '2026-06-22T11:35:00.000Z' },
    completed: false,
    timestamp: '2026-06-22T11:34:00.000Z',
    senderSessionId: 'session_leader_2',
  },
  {
    id: 'msg_btw',
    from: 'worker@f',
    to: '*',
    type: 'btw',
    subject: 'Quick update',
    body: 'FYI: Checkpoint reached, all tests passing.',
    priority: 'low',
    readBy: { 'leader@a': '2026-06-22T12:00:00.000Z' },
    completed: false,
    timestamp: '2026-06-22T11:59:00.000Z',
    senderSessionId: 'session_f',
  },
];

// ============================================================================
// EDGE CASES — Empty, very long, no body, no task context
// ============================================================================

const edgeCaseMessages: MailboxMessage[] = [
  {
    id: 'msg_empty_body',
    from: 'worker@g',
    to: 'leader@h',
    type: 'note',
    subject: 'Done',
    body: '',
    priority: 'normal',
    readBy: {},
    completed: false,
    timestamp: '2026-06-22T13:00:00.000Z',
    senderSessionId: 'session_g',
  },
  {
    id: 'msg_no_task_context',
    from: 'worker@i',
    to: 'leader@h',
    type: 'btw',
    subject: 'Status update',
    body: 'Everything is running smoothly.',
    priority: 'low',
    readBy: { 'leader@h': '2026-06-22T13:30:00.000Z' },
    completed: false,
    timestamp: '2026-06-22T13:25:00.000Z',
    senderSessionId: 'session_i',
    // No taskContext — edge case
  },
  {
    id: 'msg_no_readers',
    from: 'leader@x',
    to: '*',
    type: 'broadcast',
    subject: 'System-wide announcement',
    body: 'Scheduled maintenance in 1 hour.',
    priority: 'high',
    readBy: {}, // No one has read this yet
    completed: false,
    timestamp: '2026-06-22T14:00:00.000Z',
    senderSessionId: 'session_leader_3',
  },
  {
    id: 'msg_already_read_by_many',
    from: 'worker@j',
    to: 'team@',
    type: 'note',
    subject: 'Important update',
    body: 'Please review the new API design.',
    priority: 'high',
    readBy: {
      'leader@a': '2026-06-22T14:30:00.000Z',
      'worker@b': '2026-06-22T14:31:00.000Z',
      'worker@c': '2026-06-22T14:32:00.000Z',
      'worker@d': '2026-06-22T14:33:00.000Z',
      'worker@e': '2026-06-22T14:34:00.000Z',
    },
    completed: false,
    timestamp: '2026-06-22T14:29:00.000Z',
    senderSessionId: 'session_j',
  },
  {
    id: 'msg_secret_in_body',
    from: 'worker@k',
    to: 'leader@a',
    type: 'result',
    subject: 'Auth fix complete',
    body: 'The API key has been rotated. New key: sk_live_abcdefghijklmnopqrstuvwxyz1234567890',
    priority: 'high',
    readBy: { 'leader@a': '2026-06-22T15:00:00.000Z' },
    completed: true,
    completedBy: 'worker@k',
    completedAt: '2026-06-22T14:59:00.000Z',
    outcome: 'Rotated API key successfully.',
    timestamp: '2026-06-22T14:59:00.000Z',
    senderSessionId: 'session_k',
  },
];

// ============================================================================
// LIVE AGENT STATES — Various statuses, tools, iterations
// ============================================================================

const liveAgents: MailboxAgentStatus[] = [
  {
    agentId: 'bug-hunter@s1',
    name: 'Bug Hunter',
    role: 'bug-hunter',
    sessionId: 'sess_bh_001',
    status: 'running',
    currentTool: 'grep',
    currentTask: 'Scanning for null derefs in auth module',
    iterations: 12,
    toolCalls: 847,
    lastActivityAt: '2026-06-22T16:00:00.000Z',
    lastSeenAt: '2026-06-22T16:00:00.000Z',
    online: true,
    pid: 45678,
    source: 'cli',
  },
  {
    agentId: 'security-scanner@s2',
    name: 'Security Scanner',
    role: 'security-scanner',
    sessionId: 'sess_ss_002',
    status: 'running',
    currentTool: 'bash',
    currentTask: 'Running npm audit',
    iterations: 5,
    toolCalls: 234,
    lastActivityAt: '2026-06-22T16:00:30.000Z',
    lastSeenAt: '2026-06-22T16:00:30.000Z',
    online: true,
    pid: 45679,
    source: 'cli',
  },
  {
    agentId: 'refactor-planner@s3',
    name: 'Refactor Planner',
    role: 'refactor-planner',
    sessionId: 'sess_rp_003',
    status: 'idle',
    currentTool: undefined,
    currentTask: undefined,
    iterations: 8,
    toolCalls: 156,
    lastActivityAt: '2026-06-22T15:55:00.000Z',
    lastSeenAt: '2026-06-22T16:00:45.000Z',
    online: true,
    pid: 45680,
    source: 'cli',
  },
  {
    agentId: 'test-runner@s4',
    name: 'Test Runner',
    role: 'test',
    sessionId: 'sess_tr_004',
    status: 'running',
    currentTool: 'test',
    currentTask: 'Running vitest on packages/core',
    iterations: 3,
    toolCalls: 89,
    lastActivityAt: '2026-06-22T16:00:15.000Z',
    lastSeenAt: '2026-06-22T16:00:15.000Z',
    online: true,
    pid: 45681,
    source: 'cli',
  },
  {
    agentId: 'lovelace@s5',
    name: 'Lovelace (Frontend)',
    role: 'frontend',
    sessionId: 'sess_fe_005',
    status: 'running',
    currentTool: 'read',
    currentTask: 'Reviewing React component',
    iterations: 7,
    toolCalls: 312,
    lastActivityAt: '2026-06-22T16:00:10.000Z',
    lastSeenAt: '2026-06-22T16:00:10.000Z',
    online: true,
    pid: 45682,
    source: 'cli',
  },
  {
    agentId: 'researcher@s6',
    name: 'Newton (Research)',
    role: 'research',
    sessionId: 'sess_rs_006',
    status: 'idle',
    currentTool: 'search',
    currentTask: 'Completed: WebSocket best practices',
    iterations: 15,
    toolCalls: 523,
    lastActivityAt: '2026-06-22T15:45:00.000Z',
    lastSeenAt: '2026-06-22T16:00:50.000Z',
    online: true,
    pid: 45683,
    source: 'cli',
  },
  {
    agentId: 'offline-agent@s7',
    name: 'Offline Worker',
    role: 'worker',
    sessionId: 'sess_ow_007',
    status: 'running',
    currentTool: 'bash',
    currentTask: 'Long running build',
    iterations: 2,
    toolCalls: 45,
    lastActivityAt: '2026-06-22T14:00:00.000Z', // Last activity 2 hours ago
    lastSeenAt: '2026-06-22T16:00:00.000Z', // But still "seen" recently
    online: true,
    pid: 45684,
    source: 'cli',
  },
  {
    agentId: 'leader@s8',
    name: 'Leader Agent',
    role: 'leader',
    sessionId: 'sess_ld_008',
    status: 'running',
    currentTool: 'delegate',
    currentTask: 'Coordinating fleet',
    iterations: 42,
    toolCalls: 1203,
    lastActivityAt: '2026-06-22T16:00:55.000Z',
    lastSeenAt: '2026-06-22T16:00:55.000Z',
    online: true,
    pid: 45685,
    source: 'cli',
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('HQ mailbox mapper', () => {
  it('maps mailbox messages to safe HQ summaries', () => {
    const summary = mapMailboxMessageToHqSummary(baseMessage, { previewLength: 120 });

    expect(summary).toMatchObject({
      messageId: 'msg_1',
      from: 'leader@a',
      to: '*',
      type: 'assign',
      subject: 'Review auth flow',
      priority: 'high',
      completed: false,
      readCount: 1,
      hasBody: true,
      senderSessionId: 'session_1',
      scope: 'project',
      task: {
        taskId: 'task_1',
        agentRole: 'security-scanner',
        agentName: 'Security Scanner',
        status: 'pending',
      },
    });
    expect(summary.bodyPreview).toContain('[REDACTED:bearer_token]');
    expect(summary.bodyPreview).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect('body' in summary).toBe(false);
  });

  it('maps mailbox agent status to HQ agent summary', () => {
    expect(mapMailboxAgentToHqSummary(baseAgent)).toEqual({
      agentId: 'agent@b',
      name: 'Security Scanner',
      role: 'security-scanner',
      sessionId: 'session_2',
      status: 'running',
      currentTool: 'grep',
      currentTask: 'Review auth flow',
      iterations: 4,
      toolCalls: 12,
      lastActivityAt: '2026-06-21T12:02:00.000Z',
      lastSeenAt: '2026-06-21T12:02:00.000Z',
      online: true,
      source: 'cli',
    });
  });

  it('creates project mailbox snapshots with aggregate counts', () => {
    const completedMessage: MailboxMessage = {
      ...baseMessage,
      id: 'msg_2',
      priority: 'normal',
      completed: true,
      completedBy: 'agent@b',
      completedAt: '2026-06-21T12:03:00.000Z',
      outcome: 'Done with SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
      readBy: {},
    };

    const snapshot = createMailboxSnapshotPayload([baseMessage, completedMessage], [baseAgent], {
      mailboxId: 'project_1:mailbox',
    });

    expect(snapshot.mailboxId).toBe('project_1:mailbox');
    expect(snapshot.scope).toBe('project');
    expect(snapshot.totals).toEqual({
      messages: 2,
      unread: 0,
      incomplete: 1,
      highPriority: 1,
      onlineAgents: 1,
    });
    expect(snapshot.messages).toHaveLength(2);
    const completedSummary = snapshot.messages.find((message) => message.messageId === 'msg_2');
    expect(completedSummary?.outcomePreview).toContain('[REDACTED:high_entropy_env]');
  });

  it('creates mailbox snapshots from the mailbox API', async () => {
    const mailbox = {
      query: async () => [baseMessage],
      getAgentStatuses: async () => [baseAgent],
    } satisfies Pick<Mailbox, 'query' | 'getAgentStatuses'>;

    const snapshot = await createMailboxSnapshotPayloadFromMailbox(mailbox, {
      mailboxId: 'project_1:mailbox',
      limit: 25,
    });

    expect(snapshot.messages[0]?.messageId).toBe('msg_1');
    expect(snapshot.agents[0]?.agentId).toBe('agent@b');
  });

  it('creates mailbox event payloads for message updates', () => {
    const payload = createMailboxEventPayload({
      mailboxId: 'project_1:mailbox',
      action: 'message.sent',
      message: baseMessage,
      summary: 'Sent mailbox body with[REDACTED:bearer_token]',
    });

    expect(payload.action).toBe('message.sent');
    expect(payload.message?.messageId).toBe('msg_1');
    expect(payload.summary).toContain('[REDACTED:bearer_token]');
  });

  // =========================================================================
  // DUPLICATE MESSAGE TESTS
  // =========================================================================

  it('handles duplicate message patterns (same task, multiple recipients)', () => {
    const thread = [
      threadMsg1,
      threadMsg1Duplicate,
      threadMsg2,
      threadMsg2Broadcast,
      threadMsg3Completed,
      threadMsg3Duplicate,
    ];
    const snapshot = createMailboxSnapshotPayload(thread, [], { mailboxId: 'test:duplicate' });

    expect(snapshot.messages).toHaveLength(6);
    expect(snapshot.totals.messages).toBe(6);
    // High priority messages: threadMsg1 and threadMsg1Duplicate
    expect(snapshot.totals.highPriority).toBe(2);
    // All messages from same task_id should be tracked
    const taskIds = new Set(snapshot.messages.map((m) => m.task?.taskId));
    expect(taskIds.has('task_null_deref')).toBe(true);
  });

  it('tracks duplicate messages as unread when not read by recipient', () => {
    const snapshot = createMailboxSnapshotPayload([threadMsg1, threadMsg1Duplicate], [], {
      mailboxId: 'test:unread_dup',
    });
    expect(snapshot.totals.unread).toBe(2);
  });

  it('marks broadcast duplicates as read only if explicitly read', () => {
    const snapshot = createMailboxSnapshotPayload([threadMsg2Broadcast], [], {
      mailboxId: 'test:broadcast_dup',
    });
    expect(snapshot.totals.unread).toBe(1); // readBy is empty
  });

  // =========================================================================
  // VARIOUS MESSAGE TYPE TESTS
  // =========================================================================

  it('correctly maps all message types', () => {
    for (const msg of variousTypeMessages) {
      const summary = mapMailboxMessageToHqSummary(msg, { previewLength: 80 });
      expect(summary.type).toBe(msg.type);
      expect(summary.messageId).toBe(msg.id);
    }
  });

  it('aggregates counts for various message types in snapshot', () => {
    const snapshot = createMailboxSnapshotPayload(variousTypeMessages, [], {
      mailboxId: 'test:types',
    });
    expect(snapshot.messages).toHaveLength(6);
    expect(snapshot.totals.messages).toBe(6);
    // High priority: msg_assign and msg_ask
    expect(snapshot.totals.highPriority).toBe(2);
  });

  // =========================================================================
  // EDGE CASE TESTS
  // =========================================================================

  it('handles empty body correctly', () => {
    const summary = mapMailboxMessageToHqSummary(edgeCaseMessages[0]!, { previewLength: 80 });
    expect(summary.hasBody).toBe(false);
    // bodyPreview is undefined when body is empty
    expect(summary.bodyPreview).toBeUndefined();
  });

  it('handles missing taskContext', () => {
    const summary = mapMailboxMessageToHqSummary(edgeCaseMessages[1]!, { previewLength: 80 });
    expect(summary.task).toBeUndefined();
  });

  it('handles message with no readers (fully unread)', () => {
    const snapshot = createMailboxSnapshotPayload([edgeCaseMessages[2]!], [], {
      mailboxId: 'test:no_readers',
    });
    expect(snapshot.totals.unread).toBe(1);
    expect(snapshot.messages[0]!.readCount).toBe(0);
  });

  it('handles message read by many recipients', () => {
    const summary = mapMailboxMessageToHqSummary(edgeCaseMessages[3]!, { previewLength: 80 });
    expect(summary.readCount).toBe(5);
  });

  it('redacts secrets in body and outcome', () => {
    const summary = mapMailboxMessageToHqSummary(edgeCaseMessages[4]!, { previewLength: 200 });
    expect(summary.bodyPreview).toContain('[REDACTED:');
    expect(summary.bodyPreview).not.toContain('sk_live_');
  });

  // =========================================================================
  // LIVE AGENT STATE TESTS
  // =========================================================================

  it('maps all live agent statuses correctly', () => {
    for (const agent of liveAgents) {
      const summary = mapMailboxAgentToHqSummary(agent);
      expect(summary.agentId).toBe(agent.agentId);
      expect(summary.status).toBe(agent.status);
      expect(summary.online).toBe(agent.online);
    }
  });

  it('aggregates online agents count correctly', () => {
    const snapshot = createMailboxSnapshotPayload([], liveAgents, {
      mailboxId: 'test:live_agents',
    });
    expect(snapshot.totals.onlineAgents).toBe(liveAgents.length);
  });

  it('handles various agent statuses (running, idle)', () => {
    const running = liveAgents.filter((a) => a.status === 'running');
    const idle = liveAgents.filter((a) => a.status === 'idle');

    expect(running.length).toBeGreaterThan(0);
    expect(idle.length).toBeGreaterThan(0);
  });

  it('handles agents with no currentTool/task (idle)', () => {
    const idleAgent = liveAgents.find((a) => a.status === 'idle')!;
    const summary = mapMailboxAgentToHqSummary(idleAgent);
    expect(summary.currentTool).toBeUndefined();
    expect(summary.currentTask).toBeUndefined();
  });

  it('tracks high iteration/toolCall agents', () => {
    const highActivity = liveAgents.filter((a) => a.iterations > 10 || a.toolCalls > 500);
    expect(highActivity.length).toBeGreaterThan(0);
    const leader = liveAgents.find((a) => a.role === 'leader');
    expect(leader?.iterations).toBe(42);
    expect(leader?.toolCalls).toBe(1203);
  });

  it('detects stale agent activity (lastActivity vs lastSeen gap)', () => {
    const staleAgent = liveAgents.find((a) => a.agentId === 'offline-agent@s7')!;
    const activityGap =
      new Date(staleAgent.lastSeenAt).getTime() - new Date(staleAgent.lastActivityAt).getTime();
    // 2 hours gap between lastActivity and lastSeen indicates stale but still "online"
    expect(activityGap).toBeGreaterThan(60 * 60 * 1000); // > 1 hour
  });

  // =========================================================================
  // SESSION-SCOPED RECIPIENT ADDRESSING
  // =========================================================================

  describe('classifyMailboxRecipient', () => {
    it('classifies project broadcasts', () => {
      expect(classifyMailboxRecipient('*')).toEqual({ scope: 'project' });
      expect(classifyMailboxRecipient('all')).toEqual({ scope: 'project' });
    });

    it('classifies session-scoped recipients and returns the session id', () => {
      expect(classifyMailboxRecipient('@session:abc-123')).toEqual({
        scope: 'session',
        recipientSessionId: 'abc-123',
      });
    });

    it('falls back to agent scope when the @session token is empty', () => {
      expect(classifyMailboxRecipient('@session:')).toEqual({ scope: 'agent' });
    });

    it('classifies direct agent recipients as agent scope', () => {
      expect(classifyMailboxRecipient('leader@abcd')).toEqual({ scope: 'agent' });
      expect(classifyMailboxRecipient('worker@xyz')).toEqual({ scope: 'agent' });
    });
  });

  it('derives scope and recipientSessionId from the message recipient', () => {
    const sessionMessage: MailboxMessage = {
      ...baseMessage,
      id: 'msg_session',
      to: '@session:project_alpha',
      senderSessionId: 'session_sender',
    };
    const sessionSummary = mapMailboxMessageToHqSummary(sessionMessage, { previewLength: 80 });
    expect(sessionSummary.scope).toBe('session');
    expect(sessionSummary.recipientSessionId).toBe('project_alpha');

    const projectSummary = mapMailboxMessageToHqSummary(baseMessage, { previewLength: 80 });
    expect(projectSummary.scope).toBe('project');
    expect(projectSummary.recipientSessionId).toBeUndefined();

    const directSummary = mapMailboxMessageToHqSummary(
      { ...baseMessage, id: 'msg_direct', to: 'leader@abcd' },
      { previewLength: 80 },
    );
    expect(directSummary.scope).toBe('agent');
    expect(directSummary.recipientSessionId).toBeUndefined();
  });

  it('classifies every thread pattern message with the right scope', () => {
    const expectations = [
      { message: threadMsg1, scope: 'agent' }, // direct to bug-hunter@y
      { message: threadMsg1Duplicate, scope: 'agent' }, // direct to refactor-planner@z
      { message: threadMsg2, scope: 'agent' },
      { message: threadMsg2Broadcast, scope: 'project' },
      { message: threadMsg3Completed, scope: 'agent' },
      { message: threadMsg3Duplicate, scope: 'agent' }, // direct to audit@system
    ];
    for (const { message, scope } of expectations) {
      const summary = mapMailboxMessageToHqSummary(message, { previewLength: 80 });
      expect(summary.scope, `scope for ${message.id}`).toBe(scope);
    }
  });

  // =========================================================================
  // FULL INTEGRATION TEST — Duplicate threads with live agents
  // =========================================================================

  it('creates comprehensive snapshot with duplicate threads and live agents', () => {
    const allMessages = [
      threadMsg1,
      threadMsg1Duplicate,
      threadMsg2,
      threadMsg2Broadcast,
      threadMsg3Completed,
      threadMsg3Duplicate,
      ...variousTypeMessages,
      ...edgeCaseMessages,
    ];

    const snapshot = createMailboxSnapshotPayload(allMessages, liveAgents, {
      mailboxId: 'test:full_integration',
    });

    // Total messages
    expect(snapshot.messages.length).toBeLessThanOrEqual(allMessages.length); // limited by default limit

    // Agents all included
    expect(snapshot.agents).toHaveLength(liveAgents.length);
    expect(snapshot.totals.onlineAgents).toBe(liveAgents.length);

    // High priority count: threadMsg1, threadMsg1Duplicate, msg_assign, msg_ask, msg_no_readers, msg_already_read_by_many, msg_secret_in_body
    // In snapshot with default limit, we should have some high priority
    expect(snapshot.totals.messages).toBeGreaterThan(0);

    // Verify duplicate task tracking
    const taskNullDeref = snapshot.messages.filter((m) => m.task?.taskId === 'task_null_deref');
    expect(taskNullDeref.length).toBeGreaterThanOrEqual(2); // threadMsg1 + threadMsg1Duplicate
  });
});
