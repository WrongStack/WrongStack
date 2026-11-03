import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { SessionStatusBar } from '../src/SessionStatusBar';

vi.mock('../src/platform', () => ({}));

const render = (active: string[] | null) =>
  renderToStaticMarkup(
    createElement(SessionStatusBar, {
      state: {
        ...emptyEngineState,
        connected: true,
        memoryContext: active && { at: '', active, entered: [], exited: [] },
      },
      command: vi.fn(async () => ({})),
      refresh: () => {},
    }),
  );

describe('status bar memory count', () => {
  it('counts the memories kept in the context, as the WebUI header badge does', () => {
    expect(render(['m1', 'm2', 'm3'])).toMatch(/Memory (<!-- -->)?3</);
    expect(render([])).not.toContain('Memory');
    expect(render(null)).not.toContain('Memory');
  });
});
