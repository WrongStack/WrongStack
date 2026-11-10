import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
// The story lives in the shared package and translates with the app's i18next instance.
import '../../src/i18n';
import { ContextTimeline } from '../../src/components/session-story/ContextTimeline';
import type { ChronicleEventView } from '../../src/types';

afterEach(cleanup);

function event(eventType: string, at: number, attributes: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    eventId: `${eventType}-${at}`,
    eventType,
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(at).toISOString(),
    persistedAt: new Date(at).toISOString(),
    sequence: at,
    hash: '',
    previousHash: '',
    scope: { sessionId: 's1' },
    correlation: {},
    attributes,
  } satisfies ChronicleEventView;
}

const point = (at: number, seq: number, verdict = 'hit', breakers: string[] = []) =>
  event('context.residency', at, {
    agentId: 'leader',
    seq,
    provider: 'anthropic',
    model: 'opus',
    mechanism: 'explicit',
    maxContext: 200_000,
    total: 30_000,
    cached: 24_000,
    written: 4_000,
    uncached: 2_000,
    usageInput: 1_000,
    usageCacheRead: 26_000,
    usageCacheWrite: 4_000,
    verdict,
    breakers,
    segments: [
      { kind: 'system', tokens: 6_000, lane: 'cached', count: 2 },
      { kind: 'live-tail', tokens: 2_000, lane: 'uncached', count: 3 },
    ],
    live: [{ source: 'memory-evidence', tokens: 2_000 }],
    historyMessages: 4,
  });

describe('ContextTimeline', () => {
  it('grows the plot for long sessions so every bar remains horizontally scrollable', () => {
    const { container, rerender } = render(
      <ContextTimeline
        events={Array.from({ length: 80 }, (_, index) => point(1_000 + index * 1_000, index + 1))}
      />,
    );
    const svg = container.querySelector('svg');
    const chartWidth = Number(svg?.getAttribute('viewBox')?.split(' ')[2]);
    expect(chartWidth).toBeGreaterThan(1_100);
    expect(Number.parseInt(svg?.style.minWidth ?? '', 10)).toBe(chartWidth);
    expect(svg?.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
    expect(
      Number(container.querySelector('svg g:last-of-type rect')?.getAttribute('x')),
    ).toBeGreaterThan(1_100);

    rerender(<ContextTimeline events={[point(1_000, 1), point(2_000, 2)]} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1100 260');
  });

  it('draws provider-reported cache reads even when layout predicted no reusable prefix', () => {
    const { container } = render(
      <ContextTimeline
        events={[
          event('context.residency', 1_000, {
            ...point(1_000, 1).attributes,
            mechanism: 'none',
            cached: 0,
            written: 0,
            uncached: 30_000,
            usageInput: 4_000,
            usageCacheRead: 26_000,
            usageCacheWrite: 0,
          }),
        ]}
      />,
    );
    expect(container.querySelector('svg rect[fill="hsl(var(--success))"]')).not.toBeNull();
  });

  it('shows an honest empty state without residency events', () => {
    render(<ContextTimeline events={[]} />);
    expect(screen.getByText(/No context data yet/)).toBeTruthy();
  });

  it('charts requests, lists in/out in the ledger and inspects a selected request', () => {
    render(
      <ContextTimeline
        events={[
          point(1_000, 1, 'cold'),
          event('compaction.fired', 2_000, {
            report: {
              before: 40_000,
              after: 18_000,
              reductions: [{ phase: 'elide', saved: 22_000 }],
            },
          }),
          point(3_000, 2, 'miss', ['history']),
        ]}
      />,
    );
    expect(screen.getByText('Context window over time')).toBeTruthy();
    expect(screen.getAllByText(/\+6\.0k in|\+2\.0k in/).length).toBeGreaterThan(0);
    expect(screen.getByText(/−22\.0k out/)).toBeTruthy();
    expect(screen.getByText(/elide −22,000/)).toBeTruthy();
    // Latest request is focused by default: its verdict and breaker show.
    expect(screen.getAllByText(/Miss — nothing was read from cache/).length).toBeGreaterThan(0);
    expect(screen.getByText(/History rewritten/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /#1 ·/ }));
    expect(screen.getAllByText(/Cold start/).length).toBeGreaterThan(0);
    expect(screen.getByText(/memory-evidence/)).toBeTruthy();
  });

  it('explains chart colors and shows provider usage for the selected bar', () => {
    const { container } = render(
      <ContextTimeline
        events={[
          point(1_000, 1),
          event('context.residency', 3_000, {
            ...point(3_000, 2).attributes,
            usageInput: 4_000,
            usageCacheRead: 26_000,
            usageCacheWrite: 0,
          }),
        ]}
      />,
    );

    expect(screen.getAllByText(/provider reported reading from cache/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/provider reported writing to cache/).length).toBeGreaterThan(1);
    expect(
      screen.getAllByText(/provider did not report as cache reads or writes/).length,
    ).toBeGreaterThan(1);
    expect(screen.getAllByText(/Calculated from the request layout/)).toHaveLength(2);
    expect(
      screen
        .getAllByText(/provider reported reading from cache/)
        .every((hint) => hint.classList.contains('text-success')),
    ).toBe(true);
    expect(
      screen
        .getAllByText(/Calculated from the request layout/)
        .every((hint) => hint.classList.contains('text-primary')),
    ).toBe(true);
    expect(
      screen.getAllByText('cached').some((label) => label.classList.contains('text-success')),
    ).toBe(true);
    expect(
      screen.getAllByText('written').some((label) => label.classList.contains('text-warning')),
    ).toBe(true);

    const detail = container.querySelector('[data-testid="context-request-detail"]');
    expect(detail?.textContent).toContain('26.0k · 87%');
    expect(detail?.textContent).toContain('0 · 0%');
    expect(detail?.textContent).toContain('4.0k · 13%');

    fireEvent.click(screen.getByRole('button', { name: /#1 ·/ }));
    expect(detail?.textContent).toContain('26.0k · 84%');
    expect(detail?.textContent).toContain('4.0k · 13%');
    expect(detail?.textContent).toContain('1.0k · 3%');
  });

  it('shows an ACP agent turn as the agent’s own context, not a WrongStack request layout', () => {
    const { container } = render(
      <ContextTimeline
        events={[
          event('context.residency', 1_000, {
            agentId: 'leader',
            seq: 1,
            provider: 'acp',
            model: 'claude-code',
            mechanism: 'agent',
            maxContext: 200_000,
            total: 52_000,
            cached: 0,
            written: 0,
            uncached: 0,
            usageInput: 1_200,
            usageCacheRead: 40_000,
            usageCacheWrite: 2_000,
            verdict: 'agent',
            breakers: [],
            segments: [],
            live: [],
            historyMessages: 0,
          }),
        ]}
      />,
    );
    const detail = container.querySelector('[data-testid="context-request-detail"]');
    expect(detail?.textContent).toContain('Context held by the agent');
    expect(detail?.textContent).toContain('52.0k');
    expect(container.querySelector('[data-testid="context-agent-owned"]')?.textContent).toMatch(
      /sent it only your message.*read 40\.0k from its cache, wrote 2\.0k, fresh 1\.2k/,
    );
    expect(detail?.textContent).not.toContain('Estimated request layout');
    expect(detail?.textContent).not.toContain('layout allows');
  });

  it('draws an agent turn as its context fill, not its turn-long spend', () => {
    // Claude Code's turn usage sums every model call it made: here 650k
    // against a 200k window, while its context holds 52k.
    const agentPoint = (seq: number, total: number) =>
      event('context.residency', seq * 1_000, {
        agentId: 'leader',
        seq,
        provider: 'acp',
        model: 'claude-code',
        mechanism: 'agent',
        maxContext: 200_000,
        total,
        cached: 0,
        written: 0,
        uncached: 0,
        usageInput: 250_000,
        usageCacheRead: 400_000,
        usageCacheWrite: 0,
        verdict: 'agent',
        breakers: [],
        segments: [],
        live: [],
        historyMessages: 0,
      });
    const { container } = render(
      <ContextTimeline events={[agentPoint(1, 26_000), agentPoint(2, 52_000)]} />,
    );
    const stats = container.textContent ?? '';
    expect(stats).toMatch(/Peak\s*52\.0k/);
    const barHeight = (seq: number) =>
      [...screen.getByRole('button', { name: new RegExp(`^#${seq} ·`) }).querySelectorAll('rect')]
        .map((r) => Number(r.getAttribute('height')))
        .reduce((sum, h) => sum + h, 0);
    // Context 26k vs 52k: half the height, both inside the plot.
    expect(barHeight(1) / barHeight(2)).toBeCloseTo(0.5, 1);
    expect(barHeight(2)).toBeLessThan(260);
  });
});
