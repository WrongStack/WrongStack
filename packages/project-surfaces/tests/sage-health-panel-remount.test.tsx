/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SageDoctorReport } from '../src/sage/doctor-types.js';
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

const report: SageDoctorReport = {
  generatedAt: new Date().toISOString(),
  metrics: {
    total: 1,
    active: 1,
    byStatus: { active: 1 },
    edges: 0,
    pendingCandidates: 0,
    injections: 0,
    uses: 0,
    precision: 0,
    injectedNeverUsed: 0,
    unanchoredActive: 0,
    neverVerifiedActive: 0,
  },
  checks: [{ id: 'anchors', title: 'Anchors verified', severity: 'ok', summary: 'All good' }],
};

describe('SageHealthPanel remount', () => {
  it('reads the doctor again after a remount cancels the first read, and shows its report', async () => {
    type Listener = (message: { payload: Record<string, unknown> }) => void;
    const listeners = new Set<Listener>();
    const client = {
      on: (_type: string, listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const requests: string[] = [];
    const sageDoctor = vi.fn((payload: { requestId: string }) => {
      requests.push(payload.requestId);
    });

    // StrictMode mounts, unmounts and mounts again: the first read is cancelled on the way.
    await act(async () => {
      root!.render(
        <StrictMode>
          <SageHealthPanel
            onOpenMemory={() => {}}
            active={true}
            client={client as never}
            sageDoctor={sageDoctor as never}
          />
        </StrictMode>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });

    expect(sageDoctor).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    await act(async () => {
      for (const listener of [...listeners]) {
        listener({ payload: { requestId: requests.at(-1), report } });
      }
    });

    expect(container!.textContent).toContain('Anchors verified');
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(listeners.size).toBe(0);
  });
});
