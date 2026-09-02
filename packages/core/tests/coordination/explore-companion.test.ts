import { describe, expect, it } from 'vitest';
import { EventBus, type TrackedAgentSnapshot } from '../../src/kernel/events.js';
import type {
  Mailbox,
  MailboxAckInput,
  MailboxMessage,
  MailboxQuery,
} from '../../src/coordination/mailbox-types.js';
import {
  buildProbeTaskText,
  DEFAULT_EXPLORE_COMPANION_AGENT_ID,
  DEFAULT_EXPLORE_SEARCH_TOOLS,
  ExploreCompanion,
  type ExploreProbe,
} from '../../src/coordination/explore-companion.js';
import {
  EXPLORE_COMPANION_TOOLS,
  FLEET_ROSTER,
  applyRosterBudget,
} from '../../src/coordination/fleet.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import { agentPrompt } from '../../src/coordination/agents/agent-prompts.js';

const LEADER_SESSION = 'sess-leader';
const SUB_SESSION = 'sess-subagent';

/** Flush pending microtasks + one macrotask turn so drain()/poll run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  events: EventBus;
  probes: ExploreProbe[];
  acks: MailboxAckInput[];
  clock: { now: number };
  companion: ExploreCompanion;
}

function makeMessage(overrides: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: 'msg-1',
    from: `leader@${LEADER_SESSION}`,
    to: 'explore-companion',
    type: 'ask',
    subject: 'Where is the config parsed?',
    body: 'Find where FleetConfig is parsed.',
    priority: 'normal',
    readBy: {},
    completed: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Fake mailbox: `messages` is the pollable inbox; an acked message is
 * treated as read (excluded from later polls), mirroring unreadBy.
 */
function makeMailbox(messages: MailboxMessage[]) {
  const acks: MailboxAckInput[] = [];
  const mailbox = {
    query: async (q: MailboxQuery) => {
      const acked = new Set(acks.map((a) => a.messageId));
      return messages.filter((m) => !acked.has(m.id)).slice(0, q.limit ?? 20);
    },
    ack: async (input: MailboxAckInput) => {
      acks.push(input);
      return null;
    },
  } as unknown as Mailbox;
  return { mailbox, acks };
}

function makeHarness(
  overrides: Partial<ConstructorParameters<typeof ExploreCompanion>[0]> = {},
  mailboxMessages: MailboxMessage[] = [],
): Harness {
  const events = new EventBus();
  const { mailbox, acks } = makeMailbox(mailboxMessages);
  const probes: ExploreProbe[] = [];
  const clock = { now: 1_000_000 };
  const companion = new ExploreCompanion({
    events,
    mailbox,
    leaderSessionId: LEADER_SESSION,
    leaderAgentId: 'leader',
    onProbe: async (probe) => {
      probes.push(probe);
      return { subagentId: 'resident', taskId: `task-${probes.length}` };
    },
    // Short poll so mailbox tests observe a poll cycle within one flush.
    pollIntervalMs: 5,
    now: () => clock.now,
    ...overrides,
  });
  companion.start();
  return { events, probes, acks, clock, companion };
}

function toolExecuted(
  events: EventBus,
  overrides: Partial<{
    name: string;
    ok: boolean;
    sessionId?: string;
    input: unknown;
    output: string;
    outputLines: number;
  }>,
): void {
  events.emit('tool.executed', {
    name: 'edit',
    durationMs: 5,
    ok: true,
    sessionId: LEADER_SESSION,
    ...overrides,
  } as never);
}

function agentSnapshot(id: string, todos: TrackedAgentSnapshot['todos']): TrackedAgentSnapshot {
  return {
    id,
    name: id,
    status: 'running',
    iterations: 1,
    toolCalls: 1,
    lastActivityAt: new Date().toISOString(),
    todos,
  };
}

describe('ExploreCompanion trigger mapping', () => {
  it('edit on a file the leader never read → map-file probe with file hint', async () => {
    const h = makeHarness();
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('edit_unread_file');
    expect(h.probes[0]?.subject).toBe('file:src/a.ts');
    expect(h.probes[0]?.hint?.file).toBe('src/a.ts');
  });

  it('edit on an already-read file → no probe', async () => {
    const h = makeHarness();
    toolExecuted(h.events, { name: 'read', input: { path: 'src/a.ts' } });
    await flush();
    h.probes.length = 0;
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('unfamiliar read → skeleton probe; re-read → no second probe', async () => {
    const h = makeHarness();
    toolExecuted(h.events, { name: 'read', input: { path: 'src/b.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('unfamiliar_read');
    toolExecuted(h.events, { name: 'read', input: { path: 'src/b.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
  });

  it('zero-result search → locate probe carrying the query', async () => {
    const h = makeHarness();
    toolExecuted(h.events, {
      name: 'grep',
      input: { pattern: 'FleetConfig' },
      output: 'total: 0 matches',
    });
    await flush();
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('search_zero_hits');
    expect(h.probes[0]?.subject).toBe('search:FleetConfig');
    expect(h.probes[0]?.hint?.symbol).toBe('FleetConfig');
  });

  it('search with results → no probe', async () => {
    const h = makeHarness();
    toolExecuted(h.events, {
      name: 'grep',
      input: { pattern: 'FleetConfig' },
      output: 'src/a.ts:1: export interface FleetConfig',
      outputLines: 1,
    });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('leader todo flip to in_progress → pre-map probe', async () => {
    const h = makeHarness();
    h.events.emit('session.agents_updated', {
      sessionId: LEADER_SESSION,
      agents: [
        agentSnapshot('leader', [
          { id: 't1', content: 'Register role in fleet.ts', status: 'pending' },
        ]),
      ],
    });
    await flush();
    expect(h.probes).toHaveLength(0);
    h.events.emit('session.agents_updated', {
      sessionId: LEADER_SESSION,
      agents: [
        agentSnapshot('leader', [
          { id: 't1', content: 'Register role in fleet.ts', status: 'in_progress' },
        ]),
      ],
    });
    await flush();
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('todo_in_progress');
    expect(h.probes[0]?.subject).toBe('todo:t1');
  });

  it('subagent todo flip → no probe (leader-scoped diff)', async () => {
    const h = makeHarness();
    h.events.emit('session.agents_updated', {
      sessionId: LEADER_SESSION,
      agents: [
        agentSnapshot('worker-1', [{ id: 't2', content: 'Edit b.ts', status: 'in_progress' }]),
      ],
    });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('error naming a file/symbol → what-is probe', async () => {
    const h = makeHarness();
    h.events.emit('error', {
      sessionId: LEADER_SESSION,
      phase: 'tool',
      err: new Error("Cannot find module 'src/missing.ts'"),
    });
    await flush();
    expect(h.probes.length).toBeGreaterThan(0);
    expect(h.probes.every((p) => p.source === 'error_symbol')).toBe(true);
    // The file regex captures the path-qualified token as written in the error.
    expect(h.probes.some((p) => p.subject === 'token:src/missing.ts')).toBe(true);
  });

  it('per-signal kill switch disables the edit signal', async () => {
    const h = makeHarness({ signals: { editUnreadFile: false } });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/c.ts' } });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('enabled:false → start() attaches nothing', () => {
    const h = makeHarness({ enabled: false });
    expect(h.companion.isRunning()).toBe(false);
  });
});

describe('ExploreCompanion session filtering', () => {
  it('subagent-session tool events never trigger probes', async () => {
    const h = makeHarness();
    toolExecuted(h.events, {
      name: 'edit',
      sessionId: SUB_SESSION,
      input: { path: 'src/a.ts' },
    });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('subagent-session errors never trigger probes', async () => {
    const h = makeHarness();
    h.events.emit('error', {
      sessionId: SUB_SESSION,
      phase: 'tool',
      err: new Error("Cannot find module 'src/missing.ts'"),
    });
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('events without a sessionId are dropped (strict fail-closed filter)', async () => {
    const h = makeHarness();
    h.events.emit('tool.executed', {
      name: 'edit',
      durationMs: 1,
      ok: true,
      input: { path: 'src/legacy.ts' },
    } as never);
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('unstamped error and agents_updated events are dropped too', async () => {
    const h = makeHarness();
    h.events.emit('error', {
      phase: 'tool',
      err: new Error("Cannot find module 'src/missing.ts'"),
    } as never);
    h.events.emit('session.agents_updated', {
      agents: [
        agentSnapshot('leader', [{ id: 't1', content: 'Map src/x.ts', status: 'in_progress' }]),
      ],
    } as never);
    await flush();
    expect(h.probes).toHaveLength(0);
  });

  it('unresolved lazy leaderSessionId getter drops events until it resolves', async () => {
    let sid: string | undefined;
    const h = makeHarness({ leaderSessionId: () => sid });
    sid = LEADER_SESSION;
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
    h.probes.length = 0;
    sid = undefined;
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/b.ts' } });
    await flush();
    expect(h.probes).toHaveLength(0);
  });
});

describe('ExploreCompanion cooldown and queue bounds', () => {
  it('same subject within cooldownMs is skipped; after cooldown it re-probes', async () => {
    const h = makeHarness({ cooldownMs: 1_000 });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(1);
    h.clock.now += 1_001;
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(h.probes).toHaveLength(2);
  });

  it('different subjects are independent — no cross-cooldown', async () => {
    const h = makeHarness({ cooldownMs: 60_000 });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/b.ts' } });
    await flush();
    expect(h.probes).toHaveLength(2);
  });

  it('pending queue caps at maxPending and drops the oldest queued', async () => {
    // onProbe records the dispatch, then never resolves → the first probe
    // holds the flight slot forever and the rest queue behind it.
    const dispatched: string[] = [];
    const h = makeHarness({
      maxPending: 2,
      onProbe: (probe) => {
        dispatched.push(probe.subject);
        return new Promise(() => {});
      },
    });
    for (const p of ['a', 'b', 'c', 'd']) {
      toolExecuted(h.events, { name: 'edit', input: { path: `src/${p}.ts` } });
    }
    await flush();
    // a is in flight (dispatched, never resolving); b queued, then c; d
    // arrives at the cap of 2 and drops the oldest queued (b).
    expect(dispatched).toEqual(['file:src/a.ts']);
    expect(h.companion.pendingCount()).toBe(2);
  });

  it('a rejected onProbe is swallowed and the next probe still dispatches', async () => {
    let calls = 0;
    const h = makeHarness({
      onProbe: async (probe) => {
        calls += 1;
        if (calls === 1) throw new Error('spawn rejected');
        h.probes.push(probe);
        return { subagentId: 'r', taskId: 't' };
      },
    });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    expect(calls).toBe(1);
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/b.ts' } });
    await flush();
    expect(calls).toBe(2);
    expect(h.probes.map((x) => x.subject)).toEqual(['file:src/b.ts']);
  });
});

describe('ExploreCompanion non-blocking contract', () => {
  it('emit returns synchronously while onProbe is pending forever', async () => {
    const dispatched: string[] = [];
    const h = makeHarness({
      onProbe: (probe) => {
        dispatched.push(probe.subject);
        return new Promise(() => {});
      },
    });
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/a.ts' } });
    await flush();
    // The probe dispatched (onProbe called) even though it never resolves.
    expect(dispatched).toEqual(['file:src/a.ts']);
    // A second subject queues behind the stuck flight instead of blocking.
    toolExecuted(h.events, { name: 'edit', input: { path: 'src/b.ts' } });
    expect(h.companion.pendingCount()).toBe(1);
  });
});

describe('ExploreCompanion mailbox-ask gating', () => {
  it('ask from the leader → probe + read/completed ack', async () => {
    const h = makeHarness({}, [makeMessage({})]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('mailbox_ask');
    expect(h.probes[0]?.subject).toBe('mail:msg-1');
    expect(h.acks).toHaveLength(1);
    expect(h.acks[0]?.completed).toBe(true);
  });

  it('ask from a non-leader peer → no probe, no ack', async () => {
    const h = makeHarness({}, [
      makeMessage({ from: 'random-peer', senderSessionId: 'sess-other' }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('sender whose sessionId equals the leader session is trusted', async () => {
    const h = makeHarness({}, [
      makeMessage({ from: 'orchestrator', senderSessionId: LEADER_SESSION }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('mailbox_ask');
  });

  it('status mail from the leader is ignored (only ask/assign act)', async () => {
    const h = makeHarness({}, [makeMessage({ type: 'status' })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('leader ask addressed to ANOTHER agent → no probe, no ack', async () => {
    const h = makeHarness({}, [makeMessage({ to: 'reviewer', senderSessionId: LEADER_SESSION })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('leader-named sender from a DIFFERENT session is rejected', async () => {
    const h = makeHarness({}, [
      makeMessage({ from: 'leader@sess-other', senderSessionId: 'sess-other' }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    // `isMailboxLeader('leader@sess-other')` is true by name — the stamped
    // session id must win so one session's leader cannot steer another
    // session's companion.
    expect(h.probes).toHaveLength(0);
    expect(h.acks).toHaveLength(0);
  });

  it('global broadcast ask from the leader → probe', async () => {
    const h = makeHarness({}, [makeMessage({ to: '*', senderSessionId: LEADER_SESSION })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]?.source).toBe('mailbox_ask');
  });

  it('session-scoped broadcast ask from the leader → probe', async () => {
    const h = makeHarness({}, [
      makeMessage({ to: `@session:${LEADER_SESSION}`, senderSessionId: LEADER_SESSION }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
  });

  it('session broadcast from another session → no probe', async () => {
    const h = makeHarness({}, [
      makeMessage({ to: '@session:sess-other', senderSessionId: 'sess-other' }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(0);
  });

  it('tagged companionAgentId accepts the exact tagged recipient', async () => {
    const tagged = 'explore-companion@sess-leader';
    const h = makeHarness({ companionAgentId: tagged }, [
      makeMessage({ to: tagged, senderSessionId: LEADER_SESSION }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
  });

  it('legacy unstamped send from a bare leader name still works', async () => {
    const h = makeHarness({}, [makeMessage({ from: 'leader', senderSessionId: undefined })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.probes).toHaveLength(1);
  });
});

describe('explore-companion roster integration', () => {
  it('role resolves in FLEET_ROSTER with a read-only tool surface', () => {
    const cfg = FLEET_ROSTER[DEFAULT_EXPLORE_COMPANION_AGENT_ID];
    expect(cfg).toBeDefined();
    const tools = cfg?.tools ?? [];
    expect(tools).toEqual([...EXPLORE_COMPANION_TOOLS]);
    for (const needed of [
      'codebase-stats',
      'codebase-search',
      'codebase-skeleton',
      'codebase-repo-map',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-impact-analysis',
      'read',
      'grep',
      'glob',
      'tree',
    ]) {
      expect(tools, `tools must include ${needed}`).toContain(needed);
    }
    for (const banned of [
      'write',
      'edit',
      'replace',
      'patch',
      'bash',
      'exec',
      'delegate',
      'search',
      'codebase-index',
      'codebase-ast-replace',
      'mailbox',
    ]) {
      expect(tools, `tools must not include ${banned}`).not.toContain(banned);
    }
    for (const banned of [
      'write',
      'edit',
      'replace',
      'patch',
      'bash',
      'exec',
      'delegate',
      'search',
    ]) {
      expect(cfg?.disabledTools, `disabledTools must cover ${banned}`).toContain(banned);
    }
    expect(cfg?.allowedCapabilities).toEqual([
      ToolCapabilities.FS_READ,
      ToolCapabilities.COORDINATION_RESULT_SUBMIT,
      ToolCapabilities.SESSION_NOTE,
    ]);
    expect(cfg?.spawnBudgetExempt).toBe(true);
    expect([...DEFAULT_EXPLORE_SEARCH_TOOLS].sort()).toEqual(['codebase-search', 'grep']);
  });

  it('applyRosterBudget fills the idle window for the role', () => {
    const resolved = applyRosterBudget({
      ...FLEET_ROSTER[DEFAULT_EXPLORE_COMPANION_AGENT_ID]!,
      role: DEFAULT_EXPLORE_COMPANION_AGENT_ID,
    });
    expect(resolved.idleTimeoutMs).toBeGreaterThan(0);
    expect(resolved.maxTokens).toBe(96_000);
  });

  it('prompt file exists and is a real role brief', () => {
    const prompt = agentPrompt(DEFAULT_EXPLORE_COMPANION_AGENT_ID);
    expect(prompt.length).toBeGreaterThan(50);
    expect(prompt).toMatch(/Hard stop \(do not wander\)/i);
    expect(prompt).toMatch(/Answer the probe, then stop/i);
    expect(prompt).toMatch(/make the leader faster/i);
    expect(prompt).toMatch(/codebase-search/);
    expect(prompt).toMatch(/codebase-impact-analysis/);
    expect(prompt).toMatch(/submit_result/);
    expect(prompt).toMatch(/session\.note/);
    expect(prompt).toMatch(/Never:[\s\S]*web `search`/);
  });
});

describe('buildProbeTaskText', () => {
  it('renders the JSON probe contract the role prompt accepts', () => {
    const text = buildProbeTaskText({
      id: 'p1',
      probe: 'Map src/a.ts',
      hint: { file: 'src/a.ts' },
      context: 'leader is editing',
      source: 'edit_unread_file',
      subject: 'file:src/a.ts',
      createdAt: 0,
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['probe']).toBe('Map src/a.ts');
    expect(parsed['hint']).toEqual({ file: 'src/a.ts' });
    expect(parsed['context']).toBe('leader is editing');
    expect(typeof parsed['scope']).toBe('string');
    expect(String(parsed['scope'])).toMatch(/Answer only this probe/i);
  });

  it('omits absent hint/context', () => {
    const parsed = JSON.parse(
      buildProbeTaskText({
        id: 'p2',
        probe: 'q',
        source: 'mailbox_ask',
        subject: 'mail:m',
        createdAt: 0,
      }),
    ) as Record<string, unknown>;
    expect(parsed['probe']).toBe('q');
    expect(parsed['hint']).toBeUndefined();
    expect(parsed['context']).toBeUndefined();
    expect(typeof parsed['scope']).toBe('string');
  });
});
