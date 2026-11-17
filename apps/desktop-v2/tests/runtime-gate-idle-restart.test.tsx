/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let statuses: string[] = [];
vi.mock('../src/platform.js', () => ({
  request: async (method: string) => {
    calls.push(method);
    if (method === 'project.status') return { status: statuses.shift() ?? 'running', error: null };
    return {};
  },
}));

const { RuntimeGate } = await import('../src/RuntimeGate.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('RuntimeGate after an idle stop', () => {
  it('follows a stopping engine and starts the services again once they read as idle', async () => {
    statuses = ['running', 'stopping', 'idle', 'starting', 'running'];
    await act(async () => {
      root!.render(
        <RuntimeGate scope="project" projectId="p1">
          <p>project page</p>
        </RuntimeGate>,
      );
    });
    expect(container!.textContent).toContain('project page');
    await advance(1000);
    expect(container!.textContent).not.toContain('project page');
    await advance(250);
    expect(calls.filter((method) => method === 'project.open')).toHaveLength(2);
    await advance(500);
    expect(container!.textContent).toContain('project page');
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });
});
