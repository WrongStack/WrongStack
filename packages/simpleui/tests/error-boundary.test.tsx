// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/error-boundary.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
});

function Boom(_: { message: string }): React.JSX.Element {
  throw new Error('kaboom');
}

function render(node: React.JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    const container = render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('fine');
  });

  it('shows the fallback with the error message when a child throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = render(
      <ErrorBoundary section="test">
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    const fallback = container.querySelector('.error-boundary-fallback');
    expect(fallback?.getAttribute('role')).toBe('alert');
    expect(container.textContent).toContain('Something went wrong in this section');
    expect(container.textContent).toContain('kaboom');
    // Structured log line includes the section name.
    const logged = warn.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('simpleui.error_boundary'));
    expect(logged).toContain('"section":"test"');
  });

  it('recovers via Retry with a fresh mount of the children', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let shouldThrow = true;
    function Flaky(): React.JSX.Element {
      if (shouldThrow) throw new Error('flaky');
      return <p>recovered</p>;
    }
    const container = render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('Something went wrong');
    shouldThrow = false;
    const retry = container.querySelector<HTMLButtonElement>('.error-boundary-retry');
    act(() => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('recovered');
  });

  it('honors a custom fallback', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = render(
      <ErrorBoundary fallback={<p>custom</p>}>
        <Boom message="x" />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain('custom');
  });
});
