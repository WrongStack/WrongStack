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
