/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundServices } from '../src/BackgroundServices.js';

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

describe('BackgroundServices load sequence guard', () => {
  it('keeps newer connections.health report when an older load resolves late', async () => {
    let resolveSlow!: (v: unknown) => void;
    let resolveFast!: (v: unknown) => void;
    let call = 0;

    const command = async (type: string) => {
      if (type === 'connections.health') {
        call += 1;
        if (call === 1) {
          return new Promise((r) => {
            resolveSlow = r;
          });
        }
        return new Promise((r) => {
          resolveFast = r;
        });
      }
      return {};
    };

    await act(async () => {
      root!.render(<BackgroundServices command={command as never} autoHeals={{}} />);
    });

    await act(async () => {
      root!.render(
        <BackgroundServices
          command={command as never}
          autoHeals={{ svc: { phase: 'healthy' } as never }}
        />,
      );
    });

    await act(async () => {
      resolveFast({
        services: [{ id: 's-new', label: 'NewHealthyService', status: 'running' }],
      });
    });

    await act(async () => {
      resolveSlow({
        services: [{ id: 's-old', label: 'StaleOldService', status: 'stopped' }],
      });
    });

    expect(container!.textContent).toContain('NewHealthyService');
    expect(container!.textContent).not.toContain('StaleOldService');
  });
});
