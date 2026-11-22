// @vitest-environment jsdom
// The engine state starts as needsSetup: true until the profile engine reports. Settings
// opened in that window used to pick Quick setup and stay there for a configured profile.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { type EngineState, emptyEngineState } from '../src/engine-state';
import type { DesktopController } from '../src/useDesktop';
import { WrongStackSettings } from '../src/WrongStackSettings';

const engine = vi.hoisted(() => ({
  command: vi.fn(),
  send: vi.fn(),
  state: undefined as unknown as EngineState,
}));
vi.mock('../src/useEngine', () => ({
  useProfileEngine: () => ({ command: engine.command, send: engine.send, state: engine.state }),
}));
vi.mock('../src/RuntimeGate', () => ({
  RuntimeGate: ({ children }: React.PropsWithChildren) => children,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  { needsSetup: false, expected: 'Providers & models' },
  { needsSetup: true, expected: 'Quick setup' },
])(
  'opens $expected once the engine reports needsSetup: $needsSetup',
  async ({ needsSetup, expected }) => {
    engine.command.mockImplementation(async () => ({}));
    engine.state = { ...emptyEngineState };
    const vm = { reportError: vi.fn() } as unknown as DesktopController;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const current = () => host.querySelector('nav [aria-current="page"]')?.textContent;
    try {
      // Mounted before the profile engine reported; the section is chosen here.
      await act(async () => root.render(<WrongStackSettings vm={vm} />));
      engine.state = { ...emptyEngineState, connected: true, needsSetup };
      await act(async () => root.render(<WrongStackSettings vm={vm} />));
      expect(current()).toBe(expected);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
