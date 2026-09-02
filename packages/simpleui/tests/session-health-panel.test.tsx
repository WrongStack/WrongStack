// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionHealthPanel } from '../src/session-health-panel.js';

const roots: Root[] = [];

function renderPanel() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onOpenContextBreakdown = vi.fn();
  act(() =>
    root.render(
      <SessionHealthPanel
        context={{ load: 0.5, tokens: 5000, maxContext: 10000, cache: null }}
        messages={[
          { id: 'm1', role: 'user', text: 'hello' },
          { id: 'm2', role: 'assistant', text: 'hi', final: true },
        ]}
        sessionStart={Date.now() - 60_000}
        onOpenContextBreakdown={onOpenContextBreakdown}
      />,
    ),
  );
  return { host, onOpenContextBreakdown };
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('SessionHealthPanel', () => {
  it('starts collapsed with only the trigger visible', () => {
    const { host } = renderPanel();
    expect(host.querySelector('.health-panel-trigger')).not.toBeNull();
    expect(host.querySelector('.health-panel')).toBeNull();
  });

  it('opens the panel on trigger click and renders the CONTEXT row as an action button', () => {
    const { host } = renderPanel();
    act(() => click(host.querySelector('.health-panel-trigger') as Element));
    const panel = host.querySelector('.health-panel');
    expect(panel).not.toBeNull();
    const contextButton = host.querySelector('button[aria-label="Open context breakdown"]');
    expect(contextButton).not.toBeNull();
    expect(contextButton?.textContent).toContain('Context');
    // The thousands separator is locale-dependent (toLocaleString), so pin
    // only the stable parts of the value line.
    expect(contextButton?.textContent).toContain('tokens (50%)');
  });

  it('drills into the breakdown and closes the panel on CONTEXT click', () => {
    const { host, onOpenContextBreakdown } = renderPanel();
    act(() => click(host.querySelector('.health-panel-trigger') as Element));
    act(() => click(host.querySelector('button[aria-label="Open context breakdown"]') as Element));
    expect(onOpenContextBreakdown).toHaveBeenCalledTimes(1);
    // Panel closes so the centered breakdown modal is unobstructed.
    expect(host.querySelector('.health-panel')).toBeNull();
    expect(host.querySelector('.health-panel-trigger')).not.toBeNull();
  });

  it('makes all three stat rows drill into the breakdown and close the panel', () => {
    const { host, onOpenContextBreakdown } = renderPanel();
    const openPanel = () =>
      act(() => click(host.querySelector('.health-panel-trigger') as Element));
    openPanel();
    // Query fresh each iteration: the panel remounts on every reopen, so a
    // NodeList captured once would hold detached buttons that no longer
    // bubble through React's root listener.
    const labels = [
      'Open session uptime details',
      'Open context breakdown',
      'Open message breakdown',
    ];
    for (const label of labels) {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      onOpenContextBreakdown.mockClear();
      act(() => click(button as Element));
      expect(onOpenContextBreakdown).toHaveBeenCalledTimes(1);
      // Each drill closes the panel so the centered modal is unobstructed.
      expect(host.querySelector('.health-panel')).toBeNull();
      openPanel();
    }
  });
});
