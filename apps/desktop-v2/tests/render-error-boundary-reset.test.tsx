/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderErrorBoundary } from '../src/RenderErrorBoundary';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const lifecycle: string[] = [];

beforeEach(() => {
  lifecycle.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Stands for a project page that keeps an open file's target in its own state. */
function Page({ page }: { page: string }) {
  const [target] = useState(() => `target-${lifecycle.length}`);
  useEffect(() => {
    lifecycle.push('mount');
    return () => {
      lifecycle.push('unmount');
    };
  }, []);
  return (
    <p>
      {page}:{target}
    </p>
  );
}
function Broken({ fail }: { fail: boolean }) {
  if (fail) throw Error('render failed');
  return <p>healthy</p>;
}

describe('RenderErrorBoundary resetKey', () => {
  it('keeps a healthy page mounted, with its state, when the shown page changes', () => {
    act(() =>
      root?.render(
        <RenderErrorBoundary resetKey="project:a:reviews">
          <Page page="reviews" />
        </RenderErrorBoundary>,
      ),
    );
    act(() =>
      root?.render(
        <RenderErrorBoundary resetKey="project:a:files">
          <Page page="files" />
        </RenderErrorBoundary>,
      ),
    );
    expect(lifecycle).toEqual(['mount']);
    expect(container?.textContent).toBe('files:target-0');
  });

  it('shows recovery after a failure and clears it once another page is shown', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() =>
      root?.render(
        <RenderErrorBoundary resetKey="project:a:kit">
          <Broken fail />
        </RenderErrorBoundary>,
      ),
    );
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
    act(() =>
      root?.render(
        <RenderErrorBoundary resetKey="project:a:kit">
          <Broken fail={false} />
        </RenderErrorBoundary>,
      ),
    );
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
    act(() =>
      root?.render(
        <RenderErrorBoundary resetKey="project:a:files">
          <Broken fail={false} />
        </RenderErrorBoundary>,
      ),
    );
    expect(container?.textContent).toBe('healthy');
    vi.restoreAllMocks();
  });
});
