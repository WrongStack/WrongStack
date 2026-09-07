import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNodeData } from '../../src/components/codemap-model';

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverPolyfill);

const { CodeMapSelectedNodeSummary } = await import(
  '../../src/components/CodeMapSelectedNodeSummary'
);
const { rankAccentWidth, HUB_RANK } = await import('../../src/components/CodeMapVisuals');

afterEach(cleanup);

function node(overrides: Partial<GraphNodeData> = {}): GraphNodeData {
  return {
    id: 'file:/repo/packages/core/src/agent.ts',
    label: 'agent.ts',
    kind: 'file',
    package: '@wrongstack/core',
    file: '/repo/packages/core/src/agent.ts',
    symbolCount: 42,
    ...overrides,
  };
}

const noop = () => {};

function renderSummary(n: GraphNodeData) {
  return render(
    <CodeMapSelectedNodeSummary
      node={n}
      incomingCount={3}
      outgoingCount={7}
      onOpenNode={noop}
      onOpenActivity={noop}
    />,
  );
}

describe('rankAccentWidth', () => {
  it('thickens the accent as centrality rises', () => {
    expect(rankAccentWidth(undefined)).toContain('3px');
    expect(rankAccentWidth(0.05)).toContain('3px');
    expect(rankAccentWidth(0.4)).toContain('5px');
    expect(rankAccentWidth(HUB_RANK)).toContain('7px');
    expect(rankAccentWidth(1)).toContain('7px');
  });

  it('leaves an unranked node at the base width', () => {
    // An index with no rank pass must render exactly as it did before ranks
    // existed, not as a repository where everything is peripheral.
    expect(rankAccentWidth(undefined)).toBe(rankAccentWidth(0));
  });
});

describe('CodeMapSelectedNodeSummary', () => {
  it('shows the centrality percentage when the node carries a rank', () => {
    renderSummary(node({ rank: 0.42 }));

    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('shows a dash rather than 0% when nothing has been ranked', () => {
    renderSummary(node());

    // 0% would claim the file is measured and peripheral; it is neither.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows the concept summary when the layer has run', () => {
    renderSummary(node({ concept: 'Drives one agent turn end to end.' }));

    expect(screen.getByText('Drives one agent turn end to end.')).toBeTruthy();
  });

  it('names the crux line range next to the summary', () => {
    renderSummary(node({ concept: 'Something.', crux: { start: 42, end: 53 } }));

    // The summary is a paraphrase and can drift; the span it came from cannot.
    expect(screen.getByText(/L42.*L53/)).toBeTruthy();
  });

  it('shows the subsystem badge when one was derived', () => {
    renderSummary(node({ subsystem: 'Coordination' }));

    expect(screen.getByText('Coordination')).toBeTruthy();
  });

  it('renders an un-enriched node without empty concept or crux slots', () => {
    const { container } = renderSummary(node({ rank: 0.5 }));

    expect(container.textContent).not.toContain('crux');
    expect(container.textContent).not.toContain('undefined');
  });
});
