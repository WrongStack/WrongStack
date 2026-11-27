// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  session: 's',
  send: vi.fn(),
  listeners: new Map<string, (message: { payload: Record<string, unknown> }) => void>(),
}));
vi.mock('@/stores', () => ({ useActiveSessionId: () => mock.session }));
const client = {
  send: mock.send,
  on: (type: string, listener: (message: { payload: Record<string, unknown> }) => void) => {
    mock.listeners.set(type, listener);
    return () => mock.listeners.delete(type);
  },
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));
vi.mock('../../src/components/DiffView', () => ({
  ToolDiffView: ({ diff }: { diff: { patchText: string } }) => <pre>{diff.patchText}</pre>,
}));

import { ArtifactPreview } from '../../src/components/ArtifactPreview';

const item = {
  type: 'artifact.presentation',
  version: 2,
  kind: 'image',
  id: 'a',
  sessionId: 's',
  path: 'picture.png',
  title: 'Picture',
};
function show(value = item) {
  act(() => {
    window.dispatchEvent(new CustomEvent('wrongstack:rich-artifact', { detail: value }));
  });
}
beforeEach(() => {
  mock.session = 's';
  mock.send.mockReset();
  mock.listeners.clear();
});
afterEach(() => cleanup());
describe('rich artifact preview ownership', () => {
  it('accepts only a correlated image reply and closes on session change', () => {
    const view = render(<ArtifactPreview />);
    show();
    expect(mock.send).toHaveBeenCalledWith({
      type: 'files.image',
      payload: { sessionId: 's', filePath: 'picture.png', requestId: 'rich:a' },
    });
    const receive = mock.listeners.get('files.image')!;
    act(() =>
      receive({
        payload: {
          filePath: 'picture.png',
          sessionId: 'other',
          requestId: 'rich:a',
          dataUrl: 'data:image/png;base64,AA==',
        },
      }),
    );
    expect(screen.queryByRole('img')).toBeNull();
    act(() =>
      receive({
        payload: {
          filePath: 'picture.png',
          sessionId: 's',
          requestId: 'rich:a',
          dataUrl: 'data:image/png;base64,AA==',
        },
      }),
    );
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AA==');
    mock.session = 'other';
    view.rerender(<ArtifactPreview />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.listeners.size).toBe(0);
  });
  it('mounts the loading status region before the message is written', () => {
    render(<ArtifactPreview />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    show();
    expect(status.textContent).toBe('Loading artifact…');
  });

  it('renders a patch without inserting HTML or touching editor contents', () => {
    render(<ArtifactPreview />);
    show({ ...item, kind: 'diff', path: 'fix.patch' });
    act(() =>
      mock.listeners.get('files.read')!({
        payload: {
          filePath: 'fix.patch',
          sessionId: 's',
          requestId: 'rich:a',
          content: '+<script>danger</script>',
        },
      }),
    );
    expect(screen.getByText('+<script>danger</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  });
});
