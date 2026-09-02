import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

function memoryEntry(outcome: 'injected' | 'empty' | 'error', error?: string): HistoryEntry {
  const injected = outcome === 'injected';
  return {
    id: 1,
    kind: 'memory-activation',
    trigger: 'read',
    outcome,
    candidates: 7,
    contextPressure: 0.42,
    injectedChars: injected ? 420 : 0,
    queryPreview: 'src/auth/session.ts session auth rotate refresh token kanban-task T-42',
    // The shipped gates, written out: the card's whole job is to show a score
    // beside the bar it was measured against, so the expected bar belongs in
    // the test rather than being imported from the code under test.
    thresholds: { minScore: 0.72, minImportance: 0.5, relationFloor: 0.75 },
    activated: [
      {
        id: 'mem_auth_contract',
        kind: 'symbol_note',
        text: 'refreshSession rotates the refresh token before returning.',
        score: 0.91,
        relationStrength: 0.95,
        anchors: ['symbol:src/auth/session.ts#refreshSession'],
        tags: ['auth', 'refresh-token'],
        activationReasons: ['anchor:file-exact', 'task:#auth'],
        importance: 0.88,
        confidence: 0.94,
        freshness: 0.79,
        persistence: 'long_lived',
        metadataScore: 0.72,
        scoreTerms: [
          { label: 'metadata 0.72×0.48', value: 0.346 },
          { label: 'relation 0.95×0.48', value: 0.456 },
          { label: 'long_lived', value: 0.04 },
          { label: 'durable(symbol_note)', value: 0.04 },
          { label: 'anchored×1', value: 0.04 },
        ],
      },
    ],
    injectedIds: injected ? ['mem_auth_contract'] : [],
    rejected: {
      duplicate: 1,
      belowScore: 2,
      alreadyVisible: 0,
      cooldown: 0,
      budget: injected ? 0 : 1,
    },
    ...(error ? { error } : outcome === 'error' ? { error: 'sqlite: database is locked' } : {}),
  };
}

function frameOf(entry: HistoryEntry, termWidth = 200): string {
  const view = render(React.createElement(Entry, { entry, termWidth }));
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

describe('memory activation history card', () => {
  // A successful run is already on screen: the injected memories render as the
  // SAGE panel under the tool result they were appended to. Restating the same
  // event as a second card of arithmetic put two headers on screen for one
  // thing, so the panel carries the cost inline and the full decision proof
  // lives in the context panel — which also keeps the runs that injected
  // nothing, and which this card never showed.
  it('renders nothing for a successful injection', () => {
    expect(frameOf(memoryEntry('injected'))).toBe('');
  });

  it('renders nothing for a run that injected nothing', () => {
    expect(frameOf(memoryEntry('empty'))).toBe('');
  });

  it('still surfaces a failed run, which has no panel of its own', () => {
    const frame = frameOf(memoryEntry('error'));

    expect(frame).toContain('MEMORY INJECTOR');
    expect(frame).toContain('sqlite: database is locked');
  });

  it('shows the score, both gates, and the breakdown when the audit write failed', () => {
    // Injected AND errored: the memory did reach the model, only the
    // bookkeeping failed. The SAGE panel shows the memory; this card is the
    // only place that failure appears, so it keeps the full proof.
    const frame = frameOf(memoryEntry('injected', 'audit write failed'));

    expect(frame).toContain('audit write failed');
    // Score and relation are two independent gates; both verdicts must be
    // legible next to the bar they were tested against.
    expect(frame).toContain('0.91 ✓ 0.72');
    expect(frame).toContain('relation 0.95 ✓ 0.75');
    // The breakdown must show which term carried the memory, not just the sum.
    expect(frame).toContain('metadata 0.72×0.48 +0.35');
    expect(frame).toContain('relation 0.95×0.48 +0.46');
    // The searched text, not the user's message — usually the reason an
    // "unrelated" memory matched at all.
    expect(frame).toContain('query:');
    expect(frame).toContain('kanban-task T-42');
  });

  it('renders without thresholds or score terms for entries from older sessions', () => {
    const legacy = memoryEntry('injected', 'audit write failed') as Record<string, unknown>;
    delete legacy.thresholds;
    delete legacy.queryPreview;
    (legacy.activated as Array<Record<string, unknown>>)[0]!.scoreTerms = [];
    const frame = frameOf(legacy as never as HistoryEntry);

    expect(frame).toContain('MEMORY INJECTOR');
    // Falls back to the shipped gates rather than crashing the transcript.
    expect(frame).toContain('0.91 ✓ 0.72');
    expect(frame).toContain('older core build');
    // Legacy sessions never recorded a query line; the card silently omits it
    // rather than printing 'query: undefined'. Lock that in so a future
    // refactor that hoists the line above the proof causes this test to fail.
    expect(frame).not.toContain('query:');
  });
});
