/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PresentationProvider } from '../src/components/presentation-mode.js';
import { RuntimeControls } from '../src/components/runtime-controls.js';

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

describe('RuntimeControls refinerProvider prototype safety', () => {
  it('renders cleanly when refinerProvider is an Object.prototype key such as toString', async () => {
    const controller = {
      state: {
        id: 'sess-1',
        provider: 'openai',
        model: 'gpt-4o',
        models: { openai: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
        prefs: { refinerProvider: 'toString', refinerModel: 'm2' },
        thinking: 'medium',
        mode: 'agent',
        modes: [{ id: 'agent', name: 'Agent', description: 'Agent mode' }],
        running: false,
        providers: [],
        agents: [],
        messages: [],
        notice: '',
      },
      connection: 'open',
      ready: true,
      compactPending: false,
      modelPending: false,
      send: () => true,
      subscribe: () => () => {},
    } as never;

    await act(async () => {
      root!.render(
        <PresentationProvider>
          <RuntimeControls controller={controller} />
        </PresentationProvider>,
      );
    });

    expect(container!.textContent).toContain('m2 (saved)');
  });
});
