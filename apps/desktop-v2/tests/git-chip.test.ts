// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { GitChip } from '../src/GitChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(reply: Record<string, unknown>, connected = true) {
  const command = vi.fn(async () => reply);
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(GitChip, { command, connected }));
  });
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return { command, text };
}

describe('git chip', () => {
  it('shows the branch, commits ahead and behind, changed lines and new files', async () => {
    const { command, text } = await render({
      branch: 'main',
      ahead: 2,
      behind: 1,
      added: 40,
      deleted: 3,
      untracked: 5,
    });
    expect(command).toHaveBeenCalledWith('git.info', {}, ['git.info']);
    expect(text).toBe('main↑2↓1+40−35?');
  });

  it('shows only what is non-zero, and nothing outside a repository or while disconnected', async () => {
    expect((await render({ branch: 'feature', ahead: 0, added: 0 })).text).toBe('feature');
    expect((await render({ branch: '' })).text).toBe('');
    const offline = await render({ branch: 'main' }, false);
    expect(offline.command).not.toHaveBeenCalled();
    expect(offline.text).toBe('');
  });
});
