import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrainMessageCard } from '../src/BrainMessageCard';
import { ChimeraMessageCard } from '../src/ChimeraMessageCard';
import CouncilCard from '../src/CouncilCard';
import { councilTally, councilVetoed } from '../src/council-summary';
import { emptyEngineState } from '../src/engine-state';
import { FallbackPicker } from '../src/FallbackPicker';
import { renderOpen } from './helpers/render-open';

const brain = (decision: Parameters<typeof BrainMessageCard>[0]['decision']) =>
  renderToStaticMarkup(createElement(BrainMessageCard, { decision }));

describe('conversation event cards', () => {
  it('draws a Brain answer in its tone with the question, answer, reasoning and facts', () => {
    const html = brain({
      id: 'r1',
      kind: 'answered',
      question: 'Run the migration?',
      text: 'Ship behind a flag.',
      rationale: 'Rollback stays cheap.',
      risk: 'High risk',
      source: 'agent',
      confidence: 0.82,
    });
    expect(html).toContain('chat-event tone-success chat-brain');
    expect(html).toContain('data-brain-decision="r1"');
    for (const text of ['Run the migration?', 'Ship behind a flag.', 'Rollback stays cheap.'])
      expect(html).toContain(text);
    expect(html).toContain('<dt>Risk</dt><dd>High risk</dd>');
    // A fact's value only ever becomes a safe class name.
    expect(html).toContain('value-high-risk');
    expect(html).toContain('Confidence 82%');
  });

  it('marks a waiting question and a denial, and never invents a confidence', () => {
    const waiting = brain({
      id: 'r2',
      kind: 'ask_human',
      question: 'Which period?',
      pending: true,
    });
    expect(waiting).toContain('tone-warning');
    expect(waiting).toContain('Waiting for your response.');
    expect(waiting).not.toContain('Confidence');
    const denied = brain({ id: 'r3', kind: 'denied', reason: 'Irreversible.', pending: false });
    expect(denied).toContain('tone-danger');
    expect(denied).toContain('Irreversible.');
    // A settled denial is history: its tone shows, but it does not fill the card or speak of a
    // response prompt only a question has.
    expect(denied).not.toContain('attention');
    expect(denied).not.toContain('No open response prompt.');
    expect(waiting).toContain('attention');
    expect(brain({ id: 'r4', kind: 'ask_human', pending: false })).toContain(
      'No open response prompt.',
    );
  });

  it('keeps the Chimera report addressable with both of its decisions', () => {
    const html = renderToStaticMarkup(
      createElement(ChimeraMessageCard, { reportId: 'rep-1', text: '3 issues', onOpen: () => {} }),
    );
    expect(html).toContain('data-chimera-report="rep-1"');
    expect(html).toContain('Open report');
    expect(html).toContain('Prepare follow-up');
  });

  it('counts a model fallback down on its card', () => {
    const html = renderToStaticMarkup(
      createElement(FallbackPicker, {
        state: {
          ...emptyEngineState,
          results: {
            'provider.fallback_pending': {
              requestId: 'f1',
              from: { providerId: 'openai', model: 'gpt' },
              status: 429,
              candidates: [{ providerId: 'anthropic', model: 'claude' }],
              autoSwitchSeconds: 30,
              timestamp: Date.now(),
            },
          },
        },
        send: async () => {},
      }),
    );
    expect(html).toContain('chat-event tone-warning attention fallback-picker');
    expect(html).toContain('role="alert"');
    expect(html).toContain('chat-event-countdown');
    // The sentence states the seconds in the display language; no second, untranslated count.
    expect(html).not.toContain('chat-event-chip');
  });
});

describe('the council card', () => {
  const seat = (seatId: string, optionId: string | undefined, status = 'valid', extra = {}) => ({
    seatId,
    persona: seatId,
    status,
    optionId,
    model: `${seatId}-model`,
    at: 0,
    ...extra,
  });

  it('tallies valid votes by weight and leaves failed or pending seats out', () => {
    expect(
      councilTally([
        seat('a', 'b'),
        seat('b', 'b'),
        seat('c', 'a', 'valid', { weight: 2 }),
        seat('d', undefined, 'failed'),
      ]),
    ).toEqual([
      // Equal weight: the option more seats chose comes first.
      { option: 'b', count: 2, percent: 50 },
      { option: 'a', count: 1, percent: 50 },
    ]);
    expect(councilVetoed({ seats: [seat('a', 'deny', 'valid', { veto: true })] } as never)).toBe(
      true,
    );
  });

  it('shows the verdict, each seat and the full report, and seats still voting', () => {
    const resolved = renderOpen(
      createElement(CouncilCard, {
        decision: {
          requestId: 'c1',
          phase: 'resolved',
          resolution: 'majority',
          optionId: 'b',
          question: 'Flag or all at once?',
          durationMs: 8400,
          seats: [seat('Skeptic', 'b'), seat('Builder', 'a'), seat('Operator', 'b')],
        },
      }),
    );
    expect(resolved).toContain('tone-success');
    expect(resolved).toContain('majority · b');
    expect(resolved).toContain('3 of 3 seats · 8.4 s');
    expect(resolved).toContain('Flag or all at once?');
    expect(resolved.match(/class="chat-council-seat status-valid"/g)).toHaveLength(3);
    expect(resolved).toContain('Full council report');
    const voting = renderOpen(
      createElement(CouncilCard, {
        decision: {
          phase: 'voting',
          configuredSeatCount: 2,
          seats: [seat('Skeptic', 'b'), seat('Builder', undefined, 'pending')],
        },
      }),
    );
    expect(voting).toContain('tone-accent');
    expect(voting).toContain('1 of 2 seats');
    expect(voting).toContain('voting…');
  });
});
