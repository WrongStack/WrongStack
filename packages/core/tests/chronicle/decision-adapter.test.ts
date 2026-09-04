import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireDecisionsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

describe('decision provenance', () => {
  it('links request, resolution and outcome while hashing sensitive prose', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-decision-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's' },
      'trace',
    );
    const off = wireDecisionsToChronicle({ events, journal, context });
    const request = {
      id: 'd1',
      source: 'tool' as const,
      question: 'secret question',
      context: 'secret context',
      risk: 'high' as const,
      fallback: 'deny' as const,
    };
    events.emit('brain.decision_requested', { request, sessionId: 's', at: 1_000 });
    events.emit('brain.decision_answered', {
      request,
      sessionId: 's',
      at: 2_000,
      decision: { type: 'answer', text: 'secret answer', rationale: 'secret rationale' },
    });
    events.emit('brain.outcome', {
      requestId: 'd1',
      sessionId: 's',
      at: 3_000,
      outcome: 'success',
      detail: 'secret detail',
    });
    const recorded = await journal.readAll();
    off();
    expect(recorded.map((event) => event.eventType)).toEqual([
      'decision.requested',
      'decision.resolved',
      'decision.outcome_observed',
    ]);
    expect(recorded.every((event) => event.attributes?.decisionId === 'd1')).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('secret');
  });
});

describe('decision provenance — tier and council cost', () => {
  const mkJournal = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-decision-tier-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's' },
      'trace',
    );
    return { journal, events, off: wireDecisionsToChronicle({ events, journal, context }) };
  };
  const request = {
    id: 'd1',
    source: 'tool' as const,
    question: 'q',
    risk: 'high' as const,
    fallback: 'deny' as const,
  };

  it('records which tier resolved the decision', async () => {
    const { journal, events, off } = await mkJournal();
    events.emit('brain.decision_answered', {
      request,
      sessionId: 's',
      at: 1,
      decision: { type: 'answer', text: 'go' },
      tier: 'cache',
    });
    const recorded = await journal.readAll();
    off();
    // `resolver: 'brain'` alone flattens a free cache replay and a council
    // call into one bucket, so cross-session cost was unanswerable.
    expect(recorded[0]?.attributes?.tier).toBe('cache');
  });

  it('distinguishes the escalation prompt from a final ask_human', async () => {
    const { journal, events, off } = await mkJournal();
    events.emit('brain.decision_ask_human', {
      request,
      sessionId: 's',
      at: 1,
      decision: { type: 'ask_human', prompt: 'p' },
      pending: true,
    });
    events.emit('brain.decision_ask_human', {
      request,
      sessionId: 's',
      at: 2,
      decision: { type: 'ask_human', prompt: 'p' },
    });
    const recorded = await journal.readAll();
    off();
    expect(recorded.map((e) => e.attributes?.pending)).toEqual([true, false]);
  });

  it('persists a council resolution as structural cost data only', async () => {
    const { journal, events, off } = await mkJournal();
    events.emit('brain.council_resolved', {
      requestId: 'd1',
      sessionId: 's',
      status: 'decided',
      resolution: 'majority',
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 1,
      judgeUsed: false,
      judgeIsVoter: false,
      usage: { calls: 3, inputTokens: 90, outputTokens: 30, totalTokens: 120, durationMs: 700 },
      warnings: ['1 distinct target(s) served 3 valid vote(s)'],
      reason: 'secret rationale',
      at: 4,
    });
    const recorded = await journal.readAll();
    off();
    expect(recorded[0]?.eventType).toBe('decision.council_resolved');
    expect(recorded[0]?.attributes?.totalTokens).toBe(120);
    expect(recorded[0]?.attributes?.distinctTargetCount).toBe(1);
    // Content stays out of Chronicle: the reason is never persisted.
    expect(JSON.stringify(recorded)).not.toContain('secret');
  });
});
