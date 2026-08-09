/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeseriesChart } from '../src/lib/timeseries-chart';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('TimeseriesChart', () => {
  it('renders the configured empty state for absent or zero-only data', () => {
    mount(<TimeseriesChart points={[]} color="red" format={String} emptyLabel="Nothing yet" />);
    expect(container?.textContent).toBe('Nothing yet');
  });

  it('renders bars and exposes the hovered bucket in a tooltip', () => {
    const points = [
      { ts: Date.parse('2026-08-09T10:00:00Z'), value: 4 },
      { ts: Date.parse('2026-08-09T10:01:00Z'), value: 8 },
    ];
    mount(<TimeseriesChart points={points} color="rgb(1, 2, 3)" format={(v) => `${v} req`} />);
    const svg = container?.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 720,
      top: 0,
      right: 720,
      bottom: 140,
      height: 140,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    expect(container?.querySelectorAll('g[clip-path] rect')).toHaveLength(2);

    act(() => svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 550, bubbles: true })));
    expect(container?.querySelector('.hq-chart-tooltip-value')?.textContent).toBe('8 req');
    act(() => svg.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(container?.querySelector('.hq-chart-tooltip')).toBeNull();
  });
});
