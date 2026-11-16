// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalRecallLoader } from '../src/JournalRecallLoader';

const boundary = vi.hoisted(() => ({ request: vi.fn(), projectRequest: vi.fn() }));
vi.mock('../src/platform', () => ({ request: boundary.request }));
vi.mock('../src/journal-tail', () => ({ projectRequest: boundary.projectRequest }));
vi.mock('../src/desktop-i18n', () => ({ useDesktopText: () => ({ t: (key: string) => key }) }));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render() {
  const onLoad = vi.fn();
  await act(async () =>
    root.render(createElement(JournalRecallLoader, { projectId: 'p1', onLoad })),
  );
  return onLoad;
}

describe('optional project prompt recall', () => {
  it.each(['idle', 'starting', 'stopped', 'error'])(
    'does not start a %s project runtime for recall',
    async (status) => {
      boundary.request.mockResolvedValue({ status });
      const onLoad = await render();
      expect(boundary.request).not.toHaveBeenCalledWith('project.open', expect.anything());
      expect(boundary.projectRequest).not.toHaveBeenCalled();
      expect(onLoad).toHaveBeenCalledWith([]);
    },
  );

  it('uses a running runtime and keeps newest prompts first', async () => {
    boundary.request.mockResolvedValue({ status: 'running' });
    boundary.projectRequest.mockResolvedValue({
      entries: [
        { category: 'raw_user', content: 'older', timestamp: '2026-11-01' },
        { category: 'raw_user', content: 'newer', timestamp: '2026-11-02' },
      ],
    });
    const onLoad = await render();
    expect(boundary.projectRequest).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledWith(['newer', 'older']);
  });

  it('falls back to conversation-only recall when status is unavailable', async () => {
    boundary.request.mockRejectedValue(new Error('host unavailable'));
    expect(await render()).toHaveBeenCalledWith([]);
    expect(boundary.projectRequest).not.toHaveBeenCalled();
  });

  it('does not deliver a late status result after unmounting', async () => {
    let complete: ((value: { status: string }) => void) | undefined;
    boundary.request.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        complete = resolve;
      }),
    );
    const onLoad = await render();
    await act(async () => root.unmount());
    await act(async () => complete?.({ status: 'running' }));
    expect(onLoad).not.toHaveBeenCalled();
    expect(boundary.projectRequest).not.toHaveBeenCalled();
    root = createRoot(document.createElement('div'));
  });
});
