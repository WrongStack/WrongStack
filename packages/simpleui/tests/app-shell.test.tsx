// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/simple-ui-session.js', () => ({
  SimpleUiSession: () => <main data-simple-session-composition />,
}));

import { App } from '../src/app.js';
import { useSimpleSessionState } from '../src/hooks/use-simple-session-state.js';

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('SimpleUI production composition', () => {
  it('keeps App as a thin shell over the session-owned composition', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<App />));
    expect(host.querySelector('[data-simple-session-composition]')).not.toBeNull();
  });

  it('keeps session identity state isolated per mounted surface', () => {
    type State = ReturnType<typeof useSimpleSessionState>;
    let first: State | undefined;
    let second: State | undefined;
    const Probe = ({ capture }: { capture: (state: State) => void }) => {
      capture(useSimpleSessionState());
      return null;
    };
    for (const capture of [(state: State) => (first = state), (state: State) => (second = state)]) {
      const root = createRoot(document.createElement('div'));
      roots.push(root);
      act(() => root.render(<Probe capture={capture} />));
    }
    act(() =>
      first?.setSession({
        id: 'session-1',
        provider: 'test',
        model: 'model',
        projectName: 'Project',
        cwd: '/project',
        maxContext: 1_000,
      }),
    );
    expect(first?.session?.id).toBe('session-1');
    expect(second?.session).toBeNull();
  });
});
