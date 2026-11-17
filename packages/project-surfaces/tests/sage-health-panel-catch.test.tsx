/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SageHealthPanel } from '../src/sage/SageHealthPanel.js';

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

describe('SageHealthPanel error and finally cleanup', () => {
  it('cleans up listener, unlocks loading state, and avoids unhandled rejection when sageDoctor throws', async () => {
    let activeListeners = 0;
    const client = {
      on: () => {
        activeListeners += 1;
        return () => {
          activeListeners -= 1;
        };
      },
    };
    const sageDoctor = vi.fn(() => {
      throw new Error('SAGE_DOCTOR_SEND_FAILED');
    });

    await act(async () => {
      root!.render(
        <SageHealthPanel active={true} client={client as never} sageDoctor={sageDoctor} />,
      );
    });
    await new Promise((r) => setTimeout(r, 15));

    expect(activeListeners).toBe(0);
    expect(container!.textContent).toContain('SAGE_DOCTOR_SEND_FAILED');
    const buttons = Array.from(container!.querySelectorAll('button'));
    const refreshBtn = buttons.find((b) => !b.disabled);
    expect(refreshBtn).toBeDefined();

    await act(async () => {
      refreshBtn!.click();
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(sageDoctor).toHaveBeenCalledTimes(2);
    expect(activeListeners).toBe(0);
    expect(refreshBtn!.disabled).toBe(false);
  });
});
