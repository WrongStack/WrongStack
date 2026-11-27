/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AvailabilitySettings } from '../src/AvailabilitySettings.js';

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

describe('AvailabilitySettings catalog own-property lookup', () => {
  it('renders cleanly when rule.provider is an Object.prototype key such as toString', async () => {
    const command = async () => ({ providers: [], models: [] });

    await act(async () => {
      root!.render(
        <AvailabilitySettings
          draft={{
            modelAvailabilitySchedule: [
              { id: 'r1', enabled: true, provider: 'toString', mode: 'blackout' },
            ],
          }}
          change={() => {}}
          command={command as never}
        />,
      );
    });

    // The provider and model pickers replace the datalists; opening the model list must not
    // read a provider named like a prototype member.
    const model = container!.querySelector<HTMLInputElement>(
      'input[role="combobox"][aria-label="Window 1 model"]',
    );
    expect(model).not.toBeNull();
    await act(async () => {
      model!.focus();
    });
    expect([...container!.querySelectorAll('[role="option"]')]).toHaveLength(0);
  });
});
