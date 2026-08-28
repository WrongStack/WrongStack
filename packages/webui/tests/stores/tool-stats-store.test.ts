import { beforeEach, describe, expect, it } from 'vitest';
import {
  bucketSuccessRatio,
  LEADER_AGENT_KEY,
  sessionInFlight,
  useToolStatsStore,
} from '../../src/stores/tool-stats-store.js';

const stats = () => useToolStatsStore.getState();
const session = (id: string) => stats().sessions[id]!;

beforeEach(() => stats().clearAll());

// ── tool.started ──────────────────────────────────────────────────

describe('recordToolStarted', () => {
  it('creates the session and counts the call for the leader by default', () => {
    stats().recordToolStarted('s1', { name: 'read' });
    const s = session('s1');
    expect(s.perTool['read']!.started).toBe(1);
    expect(s.perAgent[LEADER_AGENT_KEY]!.started).toBe(1);
  });

  it('attributes the call to the named agent when the wire carries agentName', () => {
    stats().recordToolStarted('s1', { name: 'bash', agentName: 'helper-1' });
    const s = session('s1');
    expect(s.perAgent['helper-1']!.started).toBe(1);
    expect(s.perAgent[LEADER_AGENT_KEY]).toBeUndefined();
  });

  it('keeps tabs isolated — same tool name in two sessions', () => {
    stats().recordToolStarted('s1', { name: 'read' });
    stats().recordToolStarted('s2', { name: 'read' });
    stats().recordToolStarted('s2', { name: 'read' });
    expect(session('s1').perTool['read']!.started).toBe(1);
    expect(session('s2').perTool['read']!.started).toBe(2);
  });
});

// ── tool.executed ─────────────────────────────────────────────────

describe('recordToolExecuted', () => {
  it('splits ok/failed and accumulates duration', () => {
    stats().recordToolExecuted('s1', { name: 'read', ok: true, durationMs: 120 });
    stats().recordToolExecuted('s1', { name: 'read', ok: false, durationMs: 80 });
    const bucket = session('s1').perTool['read']!;
    expect(bucket.ok).toBe(1);
    expect(bucket.failed).toBe(1);
    expect(bucket.totalMs).toBe(200);
    expect(bucketSuccessRatio(bucket)).toBe(0.5);
  });

  it('counts an executed event that never had a matching started', () => {
    stats().recordToolExecuted('s1', { name: 'grep', ok: true, durationMs: 10 });
    expect(session('s1').perTool['grep']!.ok).toBe(1);
  });

  it('feeds the agent-to-agent slice when agentName is present', () => {
    stats().recordToolExecuted('s1', {
      name: 'edit',
      ok: false,
      durationMs: 40,
      agentName: 'reviewer',
    });
    const agent = session('s1').perAgent['reviewer']!;
    expect(agent.failed).toBe(1);
    expect(agent.totalMs).toBe(40);
    expect(session('s1').perAgent[LEADER_AGENT_KEY]).toBeUndefined();
  });
});

// ── in-flight ─────────────────────────────────────────────────────

describe('sessionInFlight', () => {
  it('counts started minus completed calls', () => {
    stats().recordToolStarted('s1', { name: 'read' });
    stats().recordToolStarted('s1', { name: 'bash' });
    stats().recordToolStarted('s1', { name: 'edit' });
    stats().recordToolExecuted('s1', { name: 'read', ok: true, durationMs: 5 });
    expect(sessionInFlight(session('s1'))).toBe(2);
  });

  it('never goes negative when completions arrive without starts', () => {
    stats().recordToolExecuted('s1', { name: 'read', ok: true, durationMs: 5 });
    expect(sessionInFlight(session('s1'))).toBe(0);
  });
});

// ── delegation (agent-to-agent runs) ──────────────────────────────

describe('recordDelegateStarted / recordDelegateCompleted', () => {
  it('tracks started runs and completed outcomes with tool counts', () => {
    stats().recordDelegateStarted('s1', { target: 'critic' });
    stats().recordDelegateCompleted('s1', { target: 'critic', ok: true, toolCalls: 12 });
    stats().recordDelegateCompleted('s1', { target: 'critic', ok: false, toolCalls: 3 });
    const d = session('s1').delegations;
    expect(d.started).toBe(1);
    expect(d.ok).toBe(1);
    expect(d.failed).toBe(1);
    expect(d.toolCalls).toBe(15);
    expect(bucketSuccessRatio(d)).toBe(0.5);
  });

  it('clamps negative tool counts to zero', () => {
    stats().recordDelegateCompleted('s1', { target: 'critic', ok: true, toolCalls: -5 });
    expect(session('s1').delegations.toolCalls).toBe(0);
  });
});

// ── lifecycle ─────────────────────────────────────────────────────

describe('resetSession / clearAll', () => {
  it('drops exactly one session', () => {
    stats().recordToolStarted('s1', { name: 'read' });
    stats().recordToolStarted('s2', { name: 'read' });
    stats().resetSession('s1');
    expect(stats().sessions['s1']).toBeUndefined();
    expect(session('s2').perTool['read']!.started).toBe(1);
  });

  it('resetSession is a no-op for an unknown session', () => {
    stats().resetSession('ghost');
    expect(stats().sessions).toEqual({});
  });

  it('clearAll empties every session', () => {
    stats().recordToolStarted('s1', { name: 'read' });
    stats().recordToolStarted('s2', { name: 'read' });
    stats().clearAll();
    expect(stats().sessions).toEqual({});
  });
});
