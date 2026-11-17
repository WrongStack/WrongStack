/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentModeControl } from '../src/AgentModeControl.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('AgentModeControl command-switch cancellation', () => {
  it('clears stale modes on command switch and ignores stale modes.list replies', async () => {
    const gateA = deferred<Record<string, unknown>>();
    const commandA = (async () => gateA.promise) as never;
    const commandB = (async () => ({
      modes: [{ id: 'mode-B', name: 'Mode B', description: 'B' }],
      activeId: 'mode-B',
    })) as never;

    await act(async () => {
      root!.render(<AgentModeControl command={commandA} announced="" disabled={false} />);
    });

    await act(async () => {
      root!.render(<AgentModeControl command={commandB} announced="" disabled={false} />);
    });
    expect(container!.textContent).toContain('Mode B');

    await act(async () => {
      gateA.resolve({
        modes: [{ id: 'mode-A', name: 'STALE_MODE_A', description: 'A' }],
        activeId: 'mode-A',
      });
    });

    expect(container!.textContent).toContain('Mode B');
    expect(container!.textContent).not.toContain('STALE_MODE_A');
  });
});
